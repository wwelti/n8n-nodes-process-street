import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import {
	processStreetApiRequest,
	processStreetApiRequestAllItems,
} from './transport/processStreetApi';
import { getWorkflows, getTasks } from './methods/loadOptions';

/**
 * Build a simplified, lookup-friendly view of the run's form fields.
 *
 * The `/workflow-runs/{id}/form-fields` endpoint returns a verbose shape (value
 * nested under `data`, type under `fieldType`, and some fields with no `label`).
 * `flatFields` flattens each entry to `{ fieldType, label, value }` so downstream
 * nodes can do `flatFields.find(f => f.label === '...').value` without digging.
 *
 * - `label` falls back to `key` because MultiSelect/SendRichEmail fields come back
 *   with no label — this keeps every entry identifiable.
 * - `value` is unwrapped per field type: `data.value` (single-value), `data.values`
 *   (multi-value), the file object for File fields, or `null` for empty fields.
 */
function flattenFormFields(fields: IDataObject[]): IDataObject[] {
	return fields.map((field) => {
		const data = field.data as IDataObject | null | undefined;
		let value: IDataObject[string] = null;
		if (data && typeof data === 'object') {
			if ('value' in data) {
				value = data.value;
			} else if ('values' in data) {
				value = data.values;
			} else {
				// File fields (and any other object payloads) have no value/values key.
				value = data;
			}
		}
		return {
			fieldType: field.fieldType,
			label: (field.label as string) ?? (field.key as string),
			value,
		};
	});
}

export class ProcessStreetTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Process Street Trigger',
		name: 'processStreetTrigger',
		icon: 'file:processStreet.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description:
			'Starts the workflow when a Process Street event occurs. ℹ️ For webhook triggers, activate the workflow to register the webhook — Process Street rejects n8n test-mode URLs.',
		defaults: {
			name: 'Process Street Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'processStreetApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				required: true,
				options: [
					{
						name: 'Task Checked',
						value: 'TaskChecked',
						description: 'Triggers when a task is checked off',
					},
					{
						name: 'Task Ready',
						value: 'TaskReady',
						description: 'Triggers when a task is ready to be worked on',
					},
					{
						name: 'Workflow Run Completed',
						value: 'WorkflowRunCompleted',
						description: 'Triggers when a workflow run is completed',
					},
					{
						name: 'Workflow Run Created',
						value: 'WorkflowRunCreated',
						description: 'Triggers when a new workflow run is created',
					},
				],
				default: 'WorkflowRunCreated',
				description: 'The event to listen for',
			},
			{
				displayName: 'Workflow Name or ID',
				name: 'workflowId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getWorkflows',
				},
				default: '',
				description:
					'Optionally filter to a specific workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Task Name or ID',
				name: 'taskId',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTasks',
					loadOptionsDependsOn: ['workflowId'],
				},
				displayOptions: {
					show: {
						event: ['TaskChecked', 'TaskReady'],
					},
				},
				default: '',
				description:
					'Optionally filter to a specific task. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			getWorkflows,
			getTasks,
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const webhookId = webhookData.webhookId as string | undefined;

				// If we have a stored webhook ID, assume it exists.
				// Process Street doesn't expose a GET /webhooks/{id} endpoint.
				return !!webhookId;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const event = this.getNodeParameter('event') as string;
				const workflowId = this.getNodeParameter(
					'workflowId',
					'',
				) as string;
				const taskId = this.getNodeParameter('taskId', '') as string;

				const body: IDataObject = {
					url: webhookUrl,
					triggers: [event],
				};

				if (workflowId) {
					body.workflowId = workflowId;
				}
				if (taskId) {
					body.taskId = taskId;
				}

				const response = await processStreetApiRequest.call(
					this,
					'POST',
					'/webhooks',
					body,
				);

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.webhookId = response.id;

				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const webhookId = webhookData.webhookId as string | undefined;

				if (!webhookId) return true;

				try {
					await processStreetApiRequest.call(
						this,
						'DELETE',
						`/webhooks/${webhookId}`,
					);
				} catch {
					// Webhook may have already been deleted externally
					return false;
				}

				delete webhookData.webhookId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();

		// Process Street POSTs a top-level array of event objects, but guard for
		// the single-object case too. Each event is enriched in place.
		const events: IDataObject[] = Array.isArray(body)
			? (body as IDataObject[])
			: [body as IDataObject];

		// The webhook payload only embeds the form fields for the section that
		// triggered the event (e.g. the checked task), not every field on the run.
		// Fetch the complete field set for the run and attach it under two new keys,
		// leaving the original `data.formFields` untouched:
		//   - `allFormFields`: the raw, faithful API response (paginated)
		//   - `flatFields`: a simplified `{ fieldType, label, value }` view for lookups
		// Results are cached per run ID so a batched payload makes one call per run.
		const fieldsByRunId = new Map<string, IDataObject[]>();

		for (const event of events) {
			const data = (event?.data ?? {}) as IDataObject;
			const checklist = (data.checklist ?? {}) as IDataObject;
			// Task events carry the run id under data.checklist.id; workflow-run
			// events (Created/Completed) have the run itself as data, so fall back
			// to data.id.
			const runId = (checklist.id as string) || (data.id as string);

			if (!runId) {
				continue;
			}

			try {
				let fields = fieldsByRunId.get(runId);
				if (!fields) {
					fields = await processStreetApiRequestAllItems.call(
						this,
						'GET',
						`/workflow-runs/${encodeURIComponent(runId)}/form-fields`,
					);
					fieldsByRunId.set(runId, fields);
				}
				event.allFormFields = fields;
				event.flatFields = flattenFormFields(fields);
			} catch (error) {
				// The webhook responds onReceived, so a failed enrichment must not
				// drop the event. Emit the original payload and surface the error so
				// the gap is visible downstream rather than silently missing.
				event.allFormFieldsError =
					(error as Error)?.message ?? 'Failed to fetch all form fields';
			}
		}

		return {
			workflowData: [this.helpers.returnJsonArray(events)],
		};
	}
}
