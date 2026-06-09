import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import {
	processStreetApiRequest,
	processStreetApiRequestAllItems,
	processStreetUploadFile,
} from './transport/processStreetApi';
import {
	workflowRunFields,
	workflowRunOperations,
} from './descriptions/WorkflowRunDescription';
import {
	getWorkflows,
	getWorkflowRuns,
	getWorkflowFormFields,
	getTaskNames,
	getMultiSelectFormFields,
	getMultiSelectFieldOptions,
} from './methods/loadOptions';
import { getFormFields } from './methods/resourceMapping';

// The Process Street API rejects due dates that are "too close" to now,
// and in practice anything inside a ~24h window is unreliable. Require
// the due date to be at least one full day ahead to avoid surprise 400s.
const DUE_DATE_MIN_BUFFER_MS = 24 * 60 * 60 * 1000;

function validateFutureDueDate(
	ctx: IExecuteFunctions,
	dueDate: unknown,
	i: number,
): void {
	if (dueDate === null || dueDate === undefined) return;
	const iso = String(dueDate).trim();
	if (!iso) return;

	const parsed = new Date(iso).getTime();
	if (Number.isNaN(parsed)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Due Date is not a valid ISO 8601 date/time: "${iso}"`,
			{ itemIndex: i },
		);
	}

	const now = Date.now();
	if (parsed <= now + DUE_DATE_MIN_BUFFER_MS) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Due Date must be at least 24 hours in the future. You entered ${new Date(parsed).toISOString()} (UTC), but the current time is ${new Date(now).toISOString()} (UTC). The Process Street API rejects due dates that are too close to "now". If you're entering a local time, make sure the ISO 8601 string includes a timezone offset (e.g. "-07:00"), or use a Luxon expression — see the field description for an example.`,
			{ itemIndex: i },
		);
	}
}

// Map common MIME types to file extensions so uploaded files keep a sensible
// name (and a name Process Street's allowed-extension constraints accept).
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
	'application/pdf': '.pdf',
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
	'application/msword': '.doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
	'application/vnd.ms-excel': '.xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
	'text/plain': '.txt',
	'text/csv': '.csv',
	'application/zip': '.zip',
};

/** True for Process Street form-field types that require the upload endpoint. */
function isFileFieldType(fieldType: string | undefined): boolean {
	return fieldType === 'file' || fieldType === 'multifile';
}

/**
 * Fetch the workflow's form-field definitions and return a map of
 * field ID → lowercased fieldType. Used to route File/MultiFile fields to the
 * dedicated upload endpoint instead of the form-fields value endpoint.
 */
async function buildFieldTypeMap(
	ctx: IExecuteFunctions,
	workflowId: string,
): Promise<Map<string, string>> {
	const defs = (await processStreetApiRequestAllItems.call(
		ctx,
		'GET',
		`/workflows/${encodeURIComponent(workflowId)}/form-fields`,
	)) as Array<{ id?: unknown; fieldType?: unknown }>;
	const map = new Map<string, string>();
	for (const f of defs) {
		if (f && f.id !== undefined) {
			map.set(String(f.id), String(f.fieldType ?? '').toLowerCase());
		}
	}
	return map;
}

/** Derive a filename (with extension) from a URL and/or the response headers. */
function deriveUploadFilename(url: string, headers: IDataObject): string {
	const cd = String(
		headers['content-disposition'] ?? headers['Content-Disposition'] ?? '',
	);
	const cdMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
	let filename = cdMatch?.[1]?.trim();

	if (!filename) {
		try {
			const parsed = new URL(url);
			const last = parsed.pathname.split('/').filter(Boolean).pop();
			if (last) filename = decodeURIComponent(last);
		} catch {
			// not a parseable URL — fall through to the default below
		}
	}
	if (!filename) filename = 'upload';

	// Ensure the name carries an extension so Process Street serves it correctly.
	if (!/\.[a-z0-9]{1,8}$/i.test(filename)) {
		const ct = String(headers['content-type'] ?? headers['Content-Type'] ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		const ext = CONTENT_TYPE_EXTENSIONS[ct];
		if (ext) filename += ext;
	}
	return filename;
}

/**
 * Upload a file to a Process Street File/MultiFile form field.
 *
 * The form-fields *value* endpoint rejects File fields with a 400 ("Files can
 * only be uploaded to File form fields via the upload endpoint."). Instead we
 * download the file at `urlValue` and POST its bytes (multipart/form-data) to
 * the dedicated upload endpoint — the same thing Zapier does behind the scenes.
 */
async function uploadFileFromUrl(
	ctx: IExecuteFunctions,
	workflowRunId: string,
	fieldId: string,
	urlValue: string,
): Promise<void> {
	const url = urlValue.trim();
	if (!url) return;

	let response: { body: Buffer | ArrayBuffer; headers?: IDataObject };
	try {
		response = (await ctx.helpers.httpRequest({
			method: 'GET',
			url,
			encoding: 'arraybuffer',
			returnFullResponse: true,
		})) as { body: Buffer | ArrayBuffer; headers?: IDataObject };
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Could not download the file for File field ${fieldId} from "${url}": ${(error as Error).message}`,
		);
	}

	const buffer = Buffer.isBuffer(response.body)
		? response.body
		: Buffer.from(response.body as ArrayBuffer);
	const headers = (response.headers ?? {}) as IDataObject;
	const filename = deriveUploadFilename(url, headers);
	const contentType =
		String(headers['content-type'] ?? headers['Content-Type'] ?? '')
			.split(';')[0]
			.trim() || 'application/octet-stream';

	await processStreetUploadFile.call(
		ctx,
		`/workflow-runs/${encodeURIComponent(workflowRunId)}/form-fields/${encodeURIComponent(fieldId)}/upload`,
		buffer,
		filename,
		contentType,
	);
}

async function handleWorkflowRun(
	ctx: IExecuteFunctions,
	i: number,
	operation: string,
): Promise<IDataObject | IDataObject[]> {
	if (operation === 'create') {
		const workflowId = ctx.getNodeParameter('workflowId', i) as string;
		const name = ctx.getNodeParameter('name', i) as string;
		const searchBeforeCreate = ctx.getNodeParameter(
			'searchBeforeCreate',
			i,
			false,
		) as boolean;
		const additionalFields = ctx.getNodeParameter(
			'additionalFields',
			i,
		) as IDataObject;

		if (searchBeforeCreate) {
			const searchResponse = await processStreetApiRequest.call(
				ctx,
				'GET',
				'/workflow-runs',
				{},
				{ workflowId, name },
			);
			const existing =
				searchResponse?.workflowRuns ?? searchResponse ?? [];
			if (Array.isArray(existing) && existing.length > 0) {
				return existing[0] as IDataObject;
			}
		}

		validateFutureDueDate(ctx, additionalFields.dueDate, i);

		const body: IDataObject = { workflowId, name, ...additionalFields };
		const createdRun = (await processStreetApiRequest.call(
			ctx,
			'POST',
			'/workflow-runs',
			body,
		)) as IDataObject;

		// ── Collect all form field values to send in one API call ────────────────

		// 1. Resource mapper fields (text, number, boolean, date, select, etc.)
		const formFieldsMapper = ctx.getNodeParameter(
			'formFields',
			i,
			{ mappingMode: 'defineBelow', value: null },
		) as ResourceMapperValue;

		const allFields: Array<{ id: string; value: string }> = [];
		const fileFields: Array<{ id: string; url: string }> = [];

		const mapperValues = formFieldsMapper.value;
		if (mapperValues && typeof mapperValues === 'object') {
			const entries = Object.entries(mapperValues).filter(
				([, v]) => v !== null && v !== undefined && v !== '',
			);
			// File/MultiFile fields must go through the dedicated upload endpoint,
			// not the form-fields value endpoint. Fetch field types to route them.
			const fieldTypeMap =
				entries.length > 0 ? await buildFieldTypeMap(ctx, workflowId) : undefined;
			for (const [fieldId, fieldValue] of entries) {
				if (isFileFieldType(fieldTypeMap?.get(fieldId))) {
					fileFields.push({ id: fieldId, url: String(fieldValue) });
					continue;
				}
				allFields.push({
					id: fieldId,
					value: Array.isArray(fieldValue)
						? (fieldValue as unknown[]).join(',')
						: String(fieldValue),
				});
			}
		}

		// 2. Multi-select values (top-level multiOptions, encoded as "fieldId:::optionValue")
		// MultiSelect/MultiChoice fields use "values" (plural, array) not "value" (singular).
		const multiSelectValues = ctx.getNodeParameter(
			'multiSelectValues',
			i,
			[],
		) as string[];

		if (Array.isArray(multiSelectValues) && multiSelectValues.length > 0) {
			const msGrouped = new Map<string, string[]>();
			for (const encoded of multiSelectValues) {
				if (encoded.startsWith('__header__')) continue;
				const sepIdx = encoded.indexOf(':::');
				if (sepIdx === -1) continue;
				const fieldId = encoded.substring(0, sepIdx);
				const optValue = encoded.substring(sepIdx + 3);
				if (!msGrouped.has(fieldId)) msGrouped.set(fieldId, []);
				msGrouped.get(fieldId)!.push(optValue);
			}
			for (const [fieldId, values] of msGrouped) {
				allFields.push({ id: fieldId, values } as any);
			}
		}

		// 3. Group entries by field ID and send one API call per unique field.
		// Route through processStreetApiRequest so HTTP errors arrive as
		// NodeApiError with the response status code and body preserved.
		if (allFields.length > 0 || fileFields.length > 0) {
			const runData = (createdRun.workflowRun ?? createdRun) as IDataObject;
			const workflowRunId = runData.id as string;
			const errors: Array<{ fieldId: string; preview: string; error: NodeApiError }> = [];

			for (const field of allFields) {
				const preview = String(
					(field as { value?: unknown }).value
						?? (field as { values?: unknown[] }).values?.join(', ')
						?? '',
				).substring(0, 50);
				try {
					await processStreetApiRequest.call(
						ctx,
						'POST',
						`/workflow-runs/${encodeURIComponent(workflowRunId)}/form-fields`,
						{ fields: [field] } as IDataObject,
					);
				} catch (error) {
					errors.push({
						fieldId: field.id,
						preview,
						error: error as NodeApiError,
					});
				}
			}

			for (const file of fileFields) {
				const preview = file.url.substring(0, 50);
				try {
					await uploadFileFromUrl(ctx, workflowRunId, file.id, file.url);
				} catch (error) {
					errors.push({
						fieldId: file.id,
						preview,
						error: error as NodeApiError,
					});
				}
			}

			if (errors.length > 0) {
				const errorDetail = errors
					.map(({ fieldId, preview, error }) => {
						const status = error.httpCode ? ` [HTTP ${error.httpCode}]` : '';
						const body = error.description ? `\n  ${error.description}` : '';
						return `Field ${fieldId} ("${preview}")${status}: ${error.message}${body}`;
					})
					.join('\n');

				if (!ctx.continueOnFail()) {
					throw new NodeApiError(
						ctx.getNode(),
						errors[0].error as unknown as JsonObject,
						{
							message:
								errors.length === 1
									? `Workflow run created (ID: ${workflowRunId}), but updating form field ${errors[0].fieldId} failed`
									: `Workflow run created (ID: ${workflowRunId}) but ${errors.length} form field updates failed`,
							description: errorDetail,
							httpCode: errors[0].error.httpCode ?? undefined,
							itemIndex: i,
						},
					);
				}
				(runData as IDataObject).formFieldError = errorDetail;
			}
		}

		return createdRun;
	}

	if (operation === 'get') {
		const workflowRunId = ctx.getNodeParameter('workflowRunId', i) as string;
		return (await processStreetApiRequest.call(
			ctx,
			'GET',
			`/workflow-runs/${workflowRunId}`,
		)) as IDataObject;
	}

	if (operation === 'update') {
		const workflowId = ctx.getNodeParameter('workflowId', i, '') as string;
		const workflowRunId = (ctx.getNodeParameter('workflowRunId', i) as string).trim();
		const updateFields = ctx.getNodeParameter('updateFields', i) as IDataObject;

		if (!workflowRunId) {
			throw new NodeOperationError(ctx.getNode(), 'Workflow Run ID is empty', { itemIndex: i });
		}

		validateFutureDueDate(ctx, updateFields.dueDate, i);

		// The PS API requires all fields on PUT, so fetch current state first
		let current: IDataObject;
		try {
			const response = (await processStreetApiRequest.call(
				ctx,
				'GET',
				`/workflow-runs/${encodeURIComponent(workflowRunId)}`,
			)) as IDataObject;
			// API may return the run directly or nested under a key
			current = (response.workflowRun ?? response) as IDataObject;
		} catch (error) {
			// Only rewrite the message for true 404s — for any other status
			// (401/403/429/5xx/network) preserve the original NodeApiError so
			// the n8n UI keeps the HTTP status code and response body.
			const httpCode = (error as { httpCode?: string | number })?.httpCode;
			if (String(httpCode) === '404') {
				throw new NodeApiError(ctx.getNode(), error as JsonObject, {
					message: `Could not find workflow run with ID "${workflowRunId}". Make sure the ID is correct and the run exists.`,
					itemIndex: i,
				});
			}
			throw error;
		}

		const body: IDataObject = {
			name: (updateFields.name as string) || (current.name as string),
			status:
				(updateFields.status as string) || (current.status as string),
			shared:
				updateFields.shared !== undefined
					? updateFields.shared
					: current.shared,
			dueDate:
				(updateFields.dueDate as string) ||
				(current.dueDate as string) ||
				null,
		};

		await processStreetApiRequest.call(
			ctx,
			'PUT',
			`/workflow-runs/${encodeURIComponent(workflowRunId)}`,
			body,
		);

		// ── Update form field values ────────────────────────────────────────
		const allFields: Array<{ id: string; value?: string; values?: string[] }> = [];
		const fileFields: Array<{ id: string; url: string }> = [];

		// 1. Resource mapper fields
		const formFieldsMapper = ctx.getNodeParameter(
			'formFields',
			i,
			{ mappingMode: 'defineBelow', value: null },
		) as ResourceMapperValue;

		const mapperValues = formFieldsMapper.value;
		if (mapperValues && typeof mapperValues === 'object') {
			const entries = Object.entries(mapperValues).filter(
				([, v]) => v !== null && v !== undefined && v !== '',
			);
			// File/MultiFile fields must go through the dedicated upload endpoint.
			const fieldTypeMap =
				entries.length > 0 && workflowId
					? await buildFieldTypeMap(ctx, workflowId)
					: undefined;
			for (const [fieldId, fieldValue] of entries) {
				if (isFileFieldType(fieldTypeMap?.get(fieldId))) {
					fileFields.push({ id: fieldId, url: String(fieldValue) });
					continue;
				}
				allFields.push({
					id: fieldId,
					value: Array.isArray(fieldValue)
						? (fieldValue as unknown[]).join(',')
						: String(fieldValue),
				});
			}
		}

		// 2. Multi-select values (encoded as "fieldId:::optionValue")
		const multiSelectValues = ctx.getNodeParameter(
			'multiSelectValues',
			i,
			[],
		) as string[];

		if (Array.isArray(multiSelectValues) && multiSelectValues.length > 0) {
			const msGrouped = new Map<string, string[]>();
			for (const encoded of multiSelectValues) {
				if (encoded.startsWith('__header__')) continue;
				const sepIdx = encoded.indexOf(':::');
				if (sepIdx === -1) continue;
				const fieldId = encoded.substring(0, sepIdx);
				const optValue = encoded.substring(sepIdx + 3);
				if (!msGrouped.has(fieldId)) msGrouped.set(fieldId, []);
				msGrouped.get(fieldId)!.push(optValue);
			}
			for (const [fieldId, values] of msGrouped) {
				allFields.push({ id: fieldId, values });
			}
		}

		// 3. Send form field updates one at a time. Route through
		// processStreetApiRequest so HTTP errors arrive as NodeApiError with
		// the response status code and body preserved.
		const errors: Array<{ fieldId: string; error: NodeApiError }> = [];
		for (const field of allFields) {
			try {
				await processStreetApiRequest.call(
					ctx,
					'POST',
					`/workflow-runs/${encodeURIComponent(workflowRunId)}/form-fields`,
					{ fields: [field] } as IDataObject,
				);
			} catch (error) {
				errors.push({ fieldId: field.id, error: error as NodeApiError });
			}
		}

		// 4. File/MultiFile fields go through the dedicated upload endpoint.
		for (const file of fileFields) {
			try {
				await uploadFileFromUrl(ctx, workflowRunId, file.id, file.url);
			} catch (error) {
				errors.push({ fieldId: file.id, error: error as NodeApiError });
			}
		}

		const result = { ...current, ...updateFields } as IDataObject;

		if (errors.length > 0) {
			const errorDetail = errors
				.map(({ fieldId, error }) => {
					const status = error.httpCode ? ` [HTTP ${error.httpCode}]` : '';
					const body = error.description ? `\n  ${error.description}` : '';
					return `Field ${fieldId}${status}: ${error.message}${body}`;
				})
				.join('\n');

			if (!ctx.continueOnFail()) {
				throw new NodeApiError(
					ctx.getNode(),
					errors[0].error as unknown as JsonObject,
					{
						message:
							errors.length === 1
								? `Workflow run updated, but updating form field ${errors[0].fieldId} failed`
								: `Workflow run updated but ${errors.length} form field updates failed`,
						description: errorDetail,
						httpCode: errors[0].error.httpCode ?? undefined,
						itemIndex: i,
					},
				);
			}
			result.formFieldError = errorDetail;
		}

		return result;
	}

	if (operation === 'delete') {
		const workflowRunId = ctx.getNodeParameter('workflowRunId', i) as string;
		await processStreetApiRequest.call(
			ctx,
			'DELETE',
			`/workflow-runs/${workflowRunId}`,
		);
		return { id: workflowRunId, deleted: true } as IDataObject;
	}

	if (operation === 'find') {
		const returnAll = ctx.getNodeParameter('returnAll', i) as boolean;
		const filters = ctx.getNodeParameter('filters', i) as IDataObject;
		const qs: IDataObject = {};

		if (filters.workflowId) qs.workflowId = filters.workflowId;
		if (filters.name) qs.name = filters.name;
		if (filters.status) qs.status = filters.status;

		if (returnAll) {
			return (await processStreetApiRequestAllItems.call(
				ctx,
				'GET',
				'/workflow-runs',
				{},
				qs,
				'workflowRuns',
			)) as IDataObject[];
		}

		const limit = ctx.getNodeParameter('limit', i) as number;
		const results = await processStreetApiRequest.call(
			ctx,
			'GET',
			'/workflow-runs',
			{},
			qs,
		);
		const resultItems = results?.workflowRuns ?? results ?? [];
		return (Array.isArray(resultItems)
			? resultItems.slice(0, limit)
			: []) as IDataObject[];
	}

	throw new NodeOperationError(
		ctx.getNode(),
		`Unknown operation: ${operation}`,
		{ itemIndex: i },
	);
}

export class ProcessStreet implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Process Street',
		name: 'processStreet',
		icon: 'file:processStreet.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with the Process Street API',
		defaults: {
			name: 'Process Street',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'processStreetApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Workflow Run', value: 'workflowRun' },
				],
				default: 'workflowRun',
			},
			...workflowRunOperations,
			...workflowRunFields,
		],
	};

	methods = {
		loadOptions: {
			getWorkflows,
			getWorkflowRuns,
			getWorkflowFormFields,
			getTaskNames,
			getMultiSelectFormFields,
			getMultiSelectFieldOptions,
		},
		resourceMapping: {
			getFormFields,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let responseData: IDataObject | IDataObject[] | undefined;

				if (resource === 'workflowRun') {
					responseData = await handleWorkflowRun(this, i, operation);
				}

				if (responseData !== undefined) {
					if (Array.isArray(responseData)) {
						for (const item of responseData) {
							returnData.push({ json: item, pairedItem: { item: i } });
						}
					} else {
						returnData.push({
							json: responseData,
							pairedItem: { item: i },
						});
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
