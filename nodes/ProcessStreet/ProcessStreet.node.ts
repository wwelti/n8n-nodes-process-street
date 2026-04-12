import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import {
	processStreetApiRequest,
	processStreetApiRequestAllItems,
} from './transport/processStreetApi';
import {
	workflowRunFields,
	workflowRunOperations,
} from './descriptions/WorkflowRunDescription';
import {
	getWorkflows,
	getWorkflowFormFields,
	getTaskNames,
	getMultiSelectFormFields,
	getMultiSelectFieldOptions,
} from './methods/loadOptions';
import { getFormFields } from './methods/resourceMapping';

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

		const mapperValues = formFieldsMapper.value;
		if (mapperValues && typeof mapperValues === 'object') {
			for (const [fieldId, fieldValue] of Object.entries(mapperValues)) {
				if (fieldValue === null || fieldValue === undefined || fieldValue === '') continue;
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

		// 3. Group entries by field ID and send one API call per unique field
		if (allFields.length > 0) {
			const runData = (createdRun.workflowRun ?? createdRun) as IDataObject;
			const workflowRunId = runData.id as string;
			const errors: string[] = [];

			for (const field of allFields) {
				try {
					const requestBody = JSON.parse(
						JSON.stringify({ fields: [field] }),
					) as IDataObject;
					await ctx.helpers.httpRequestWithAuthentication.call(
						ctx,
						'processStreetApi',
						{
							method: 'POST',
							url: `https://public-api.process.st/api/v1.1/workflow-runs/${workflowRunId}/form-fields`,
							body: requestBody,
							json: true,
						},
					);
				} catch (error) {
					const e = error as any;
					const msg = e?.message || 'Unknown error';
					errors.push(`Field ${field.id} ("${String(field.value).substring(0, 50)}"): ${msg}`);
				}
			}

			if (errors.length > 0) {
				const errorDetail = errors.join('\n');
				if (!ctx.continueOnFail()) {
					throw new NodeOperationError(
						ctx.getNode(),
						`Workflow run created (ID: ${workflowRunId}) but ${errors.length} field(s) failed:\n${errorDetail}`,
						{ itemIndex: i },
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
		const workflowRunId = ctx.getNodeParameter('workflowRunId', i) as string;
		const updateFields = ctx.getNodeParameter('updateFields', i) as IDataObject;

		// The PS API requires all fields on PUT, so fetch current state first
		const current = (await processStreetApiRequest.call(
			ctx,
			'GET',
			`/workflow-runs/${workflowRunId}`,
		)) as IDataObject;

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
			`/workflow-runs/${workflowRunId}`,
			body,
		);
		return { ...current, ...updateFields } as IDataObject;
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
