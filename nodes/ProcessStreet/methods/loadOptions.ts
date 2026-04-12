import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';

/**
 * Helper to get a node parameter value in loadOptions context.
 * Tries getCurrentNodeParameter first (works reliably on node reopen),
 * then falls back to getNodeParameter.
 */
function getParamValue(
	ctx: ILoadOptionsFunctions,
	paramName: string,
): string {
	const current = ctx.getCurrentNodeParameter(paramName);
	if (current !== undefined && current !== null && current !== '') {
		return String(current);
	}
	try {
		const saved = ctx.getNodeParameter(paramName, '') as string;
		return saved || '';
	} catch {
		return '';
	}
}

export async function getWorkflows(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const allWorkflows: any[] = [];
	let url: string | undefined = 'https://public-api.process.st/api/v1.1/workflows';

	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		);

		const page: any[] = response?.workflows ?? [];
		if (Array.isArray(page)) {
			allWorkflows.push(...page);
		}

		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((link: any) => link.name === 'next')?.href;
	}

	return allWorkflows
		.map((workflow: any) => ({
			name: workflow.name as string,
			value: workflow.id as string,
		}))
		.sort((a: INodePropertyOptions, b: INodePropertyOptions) =>
			a.name.localeCompare(b.name),
		);
}


export async function getTasks(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) return [];

	const allTasks: any[] = [];
	let url: string | undefined =
		`https://public-api.process.st/api/v1.1/workflows/${workflowId}/tasks`;

	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		);

		const page: any[] = response?.tasks ?? [];
		if (Array.isArray(page)) {
			allTasks.push(...page);
		}

		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((link: any) => link.name === 'next')?.href;
	}

	return allTasks.map((task: any) => ({
		name: task.name as string,
		value: task.id as string,
	}));
}

/**
 * Returns task names as both name and value — used for multiOptions on MultiSelect
 * form fields, which expect comma-separated task names (not IDs) in the API payload.
 */
export async function getTaskNames(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) return [];

	const allTasks: any[] = [];
	let url: string | undefined =
		`https://public-api.process.st/api/v1.1/workflows/${workflowId}/tasks`;

	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		);

		const page: any[] = response?.tasks ?? [];
		if (Array.isArray(page)) {
			allTasks.push(...page);
		}

		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((link: any) => link.name === 'next')?.href;
	}

	return allTasks
		.filter((t: any) => t.name)
		.map((t: any) => ({ name: String(t.name), value: String(t.name) }));
}

/**
 * Loads ALL options from ALL MultiSelect fields as a flat list.
 * Each option is labeled with [field_name] prefix and encoded as
 * "fieldId:::optionValue" so the execution handler can group by field.
 */
export async function getMultiSelectFieldOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) return [];

	const BASE_URL = 'https://public-api.process.st/api/v1.1';

	// Fetch ALL form fields, find MultiSelect fields
	const allFields: any[] = [];
	let url: string | undefined = `${BASE_URL}/workflows/${workflowId}/form-fields`;
	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		) as any;
		const page: any[] = response?.fields ?? response?.formFields ?? [];
		if (Array.isArray(page)) allFields.push(...page);
		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((l: any) => l.name === 'next')?.href;
	}

	const multiFields = allFields.filter((f: any) => {
		const ft = String(f.fieldType ?? '').toLowerCase();
		return (
			MULTI_SELECT_FIELD_TYPES.has(ft) ||
			(ft.startsWith('multi') && ft !== 'multiline')
		);
	});

	if (multiFields.length === 0) return [];

	// For each MultiSelect field, fetch its /options
	const results: INodePropertyOptions[] = [];
	for (const field of multiFields) {
		const fieldId = String(field.id);
		const fieldLabel = String(field.label ?? field.key ?? field.id);

		let fieldOptions: any[] = [];
		let optUrl: string | undefined =
			`${BASE_URL}/workflows/${workflowId}/form-fields/${fieldId}/options`;
		try {
			while (optUrl) {
				const resp = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'processStreetApi',
					{ method: 'GET', url: optUrl, json: true },
				) as any;
				const page: any[] = resp?.options ?? [];
				if (Array.isArray(page)) fieldOptions.push(...page);
				const links: any[] = Array.isArray(resp?.links) ? resp.links : [];
				optUrl = links.find((l: any) => l.name === 'next')?.href;
			}
		} catch {
			// Skip if /options fails for this field
		}

		// Add a section header for this field group
		if (fieldOptions.length > 0) {
			results.push({
				name: `── ${fieldLabel} ──`,
				value: `${fieldId}:::__header__`,
				description: 'Select items below for this field',
			});
		}

		for (const opt of fieldOptions) {
			if (opt.value === undefined) continue;
			results.push({
				name: String(opt.label ?? opt.value),
				value: `${fieldId}:::${String(opt.value)}`,
			});
		}
	}

	return results;
}

const MULTI_SELECT_FIELD_TYPES = new Set([
	'multiselect',
	'multiplechoice',
	'multipleselect',
	'multipleselection',
	'multi-select',
	'checklist',
]);

/**
 * Returns only the MultiSelect-type form fields for a workflow.
 * Used to populate the field picker in the Multi-Select Fields section.
 */
export async function getMultiSelectFormFields(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) return [];

	const allFields: any[] = [];
	let url: string | undefined =
		`https://public-api.process.st/api/v1.1/workflows/${workflowId}/form-fields`;

	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		);

		const page: any[] = response?.fields ?? response?.formFields ?? [];
		if (Array.isArray(page)) {
			allFields.push(...page);
		}

		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((link: any) => link.name === 'next')?.href;
	}

	return allFields
		.filter((f: any) => {
			const ft = String(f.fieldType ?? '').toLowerCase();
			return (
				MULTI_SELECT_FIELD_TYPES.has(ft) ||
				(ft.startsWith('multi') && ft !== 'multiline')
			);
		})
		.map((f: any) => ({
			name: String(f.label ?? f.name ?? f.key ?? f.id),
			value: String(f.id),
		}));
}

export async function getWorkflowFormFields(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const workflowId = getParamValue(this, 'workflowId');
	if (!workflowId) return [];

	const allFields: any[] = [];
	let url: string | undefined =
		`https://public-api.process.st/api/v1.1/workflows/${workflowId}/form-fields`;

	while (url) {
		const response = await this.helpers.httpRequestWithAuthentication.call(
			this,
			'processStreetApi',
			{ method: 'GET', url, json: true },
		);

		const page: any[] =
			response?.formFields ?? response?.fields ?? [];
		if (Array.isArray(page)) {
			allFields.push(...page);
		}

		const links: any[] = Array.isArray(response?.links) ? response.links : [];
		url = links.find((link: any) => link.name === 'next')?.href;
	}

	return allFields.map((field: any) => ({
		name: (field.label || field.name || field.key || field.id) as string,
		value: field.id as string,
		description: field.fieldType ? `Type: ${field.fieldType}` : undefined,
	}));
}

