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

		// 2. Multi-select fields fixedCollection (values encoded as "fieldId:::optionValue")
		const multiSelectCollection = ctx.getNodeParameter(
			'multiSelectFields',
			i,
			{ fields: [] },
		) as { fields?: Array<{ fieldId: string; values: string[] }> };

		for (const entry of multiSelectCollection.fields ?? []) {
			if (!entry.fieldId || !Array.isArray(entry.values) || entry.values.length === 0) continue;

			const valuesForField: string[] = [];
			for (const encoded of entry.values) {
				const sepIdx = encoded.indexOf(':::');
				if (sepIdx === -1) {
					valuesForField.push(encoded);
					continue;
				}
				const encodedFieldId = encoded.substring(0, sepIdx);
				const optValue = encoded.substring(sepIdx + 3);
				// Skip header markers and only include values matching the selected field
				if (optValue === '__header__') continue;
				if (encodedFieldId === entry.fieldId) {
					valuesForField.push(optValue);
				}
			}

			if (valuesForField.length > 0) {
				allFields.push({ id: entry.fieldId, value: valuesForField.join(',') });
			}
		}

		// 3. Send all field updates in a single API call
		if (allFields.length > 0) {
			const runData = (createdRun.workflowRun ?? createdRun) as IDataObject;
			const workflowRunId = runData.id as string;
			try {
				const requestBody = JSON.parse(
					JSON.stringify({ fields: allFields }),
				) as IDataObject;
				await processStreetApiRequest.call(
					ctx,
					'POST',
					`/workflow-runs/${workflowRunId}/form-fields`,
					requestBody,
				);
			} catch (error) {
				const apiError = error as any;
				const details =
					apiError?.response?.body?.details ||
					apiError?.description ||
					apiError?.message ||
					'Unknown error';
				if (!ctx.continueOnFail()) {
					throw new NodeOperationError(
						ctx.getNode(),
						`Workflow run created (ID: ${workflowRunId}) but form field update failed: ${details}`,
						{ itemIndex: i },
					);
				}
				(runData as IDataObject).formFieldError = String(details);
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
