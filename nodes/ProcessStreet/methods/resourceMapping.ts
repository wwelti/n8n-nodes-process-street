import type {
	ILoadOptionsFunctions,
	INodePropertyOptions,
	ResourceMapperField,
	ResourceMapperFields,
} from 'n8n-workflow';

function getParamValue(ctx: ILoadOptionsFunctions, paramName: string): string {
	const current = ctx.getCurrentNodeParameter(paramName);
	if (current !== undefined && current !== null && current !== '') {
		return String(current);
	}
	try {
		return (ctx.getNodeParameter(paramName, '') as string) || '';
	} catch {
		return '';
	}
}

/** Field types excluded from the resource mapper entirely (unsupported via API). */
const EXCLUDED_FIELD_TYPES = new Set([
	'SendRichEmail',
	'Subtasks',
	'SubChecklist',
	'Table',
]);

const BASE = 'https://public-api.process.st/api/v1.1';

/** Fetch all pages from a PS list endpoint, collecting items under dataKey. */
async function fetchAllPages(
	ctx: ILoadOptionsFunctions,
	startUrl: string,
	dataKey: string,
): Promise<any[]> {
	const all: any[] = [];
	let url: string | undefined = startUrl;
	while (url) {
		const resp = await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		) as any;
		const page: any[] = resp?.[dataKey] ?? [];
		if (Array.isArray(page)) all.push(...page);
		const links: any[] = Array.isArray(resp?.links) ? resp.links : [];
		url = links.find((l: any) => l.name === 'next')?.href;
	}
	return all;
}

/** Fetch configured choices for a form field via the /options endpoint. */
async function fetchFieldOptions(
	ctx: ILoadOptionsFunctions,
	workflowId: string,
	fieldId: string,
): Promise<INodePropertyOptions[]> {
	try {
		const rawOptions = await fetchAllPages(
			ctx,
			`${BASE}/workflows/${workflowId}/form-fields/${encodeURIComponent(fieldId)}/options`,
			'options',
		);
		return rawOptions
			.filter((o: any) => o.value !== undefined)
			.map((o: any) => ({ name: String(o.label ?? o.value), value: String(o.value) }));
	} catch {
		return [];
	}
}

function isSelectType(ft: string): boolean {
	return ft === 'select' || ft === 'dropdown';
}

function isMultiSelectType(ft: string): boolean {
	return (
		ft === 'multiselect' ||
		ft === 'multiplechoice' ||
		ft === 'multipleselect' ||
		ft === 'multipleselection' ||
		ft === 'multi-select' ||
		ft === 'checklist' ||
		(ft.startsWith('multi') && ft !== 'multiline')
	);
}

export async function getFormFields(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) {
		return {
			fields: [],
			emptyFieldsNotice: 'Please select a Workflow first to load its form fields.',
		};
	}

	// ── 1. Fetch all form field definitions ──────────────────────────────────
	let rawFormFields = await fetchAllPages(
		this,
		`${BASE}/workflows/${workflowId}/form-fields`,
		'fields',
	);
	if (rawFormFields.length === 0) {
		rawFormFields = await fetchAllPages(
			this,
			`${BASE}/workflows/${workflowId}/form-fields`,
			'formFields',
		);
	}

	// Exclude unsupported types and MultiSelect (handled by multiSelectValues multiOptions)
	const filteredFields = rawFormFields.filter((f: any) => {
		if (EXCLUDED_FIELD_TYPES.has(f.fieldType as string)) return false;
		const ft = String(f.fieldType ?? '').toLowerCase();
		if (isMultiSelectType(ft)) return false;
		return true;
	});

	// ── 2. Fetch /options for Select/Dropdown fields (sequential) ────────────
	const fieldOptionsMap = new Map<string, INodePropertyOptions[]>();
	for (const f of filteredFields) {
		const ft = String(f.fieldType ?? '').toLowerCase();
		if (isSelectType(ft)) {
			const opts = await fetchFieldOptions(this, workflowId, String(f.id));
			if (opts.length > 0) {
				fieldOptionsMap.set(String(f.id), opts);
			}
		}
	}

	// ── 3. Map each field to a ResourceMapperField ────────────────────────────
	const fields: ResourceMapperField[] = filteredFields.map((f: any): ResourceMapperField => {
		const ft = String(f.fieldType ?? '').toLowerCase();
		const base = {
			id: String(f.id),
			displayName: String(f.label ?? f.name ?? f.key ?? f.id),
			defaultMatch: false,
			required: false,
			display: true,
		};

		// Select / Dropdown — single-select dropdown with configured choices
		if (isSelectType(ft)) {
			const opts = fieldOptionsMap.get(String(f.id));
			if (opts && opts.length > 0) return { ...base, type: 'options', options: opts };
			return { ...base, type: 'string' };
		}

		// Typed primitives
		if (ft === 'number') return { ...base, type: 'number' };
		if (ft === 'checkbox' || ft === 'boolean') return { ...base, type: 'boolean' };
		if (ft === 'date' || ft === 'datetime') return { ...base, type: 'dateTime' };

		// Default: string (Text, Textarea, Email, Url, Snippet, Members, etc.)
		return { ...base, type: 'string' };
	});

	return { fields };
}
