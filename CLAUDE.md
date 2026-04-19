# n8n-nodes-process-street

Custom n8n community node package for Process Street workflow automation.

## Commands

- **Build**: `npm run build`
- **Lint**: `npm run lint` / `npm run lintfix`
- **Dev** (watch mode): `npm run dev`
- **Local test**: `npm link` in this dir, then `npm link n8n-nodes-process-street` in your n8n install, restart n8n

## Architecture

```
credentials/
  ProcessStreetApi.credentials.ts    # API Key auth via X-API-Key header
nodes/ProcessStreet/
  ProcessStreet.node.ts              # Action node (1 resource: Workflow Run)
  ProcessStreetTrigger.node.ts       # Webhook trigger (4 events)
  transport/processStreetApi.ts      # Shared HTTP helpers, pagination, error handling
  methods/loadOptions.ts             # Dynamic dropdown loaders: getWorkflows, getWorkflowRuns, getTasks, getTaskNames, getWorkflowFormFields, getMultiSelectFormFields, getMultiSelectFieldOptions
  methods/resourceMapping.ts         # Resource mapper: getFormFields (dynamic form with Select/Dropdown choices; excludes SendRichEmail, Subtasks, SubChecklist, Table)
  descriptions/
    WorkflowRunDescription.ts        # Workflow Run resource operations & fields
  processStreet.svg                  # Node icon
```

## Process Street API Reference

- **Base URL**: `https://public-api.process.st/api/v1.1`
- **Auth**: `X-API-Key` header with API key value
- **Test auth**: `GET /testAuth` returns `{ apiKeyLabel: string }`
- **Pagination**: 20 items/page, link-based. The response includes a top-level `links` array. The next-page link has `name: "next"` and `type: "Api"` — the `rel` field is a resource-type label (e.g. `"Tasks"`, `"Workflow Run"`) and is never `"next"`. Always find the next page with `links.find(l => l.name === 'next')?.href`.
- **Rate limiting**: 429 status with `Retry-After` header
- **Docs**: https://public-api.process.st/api/v1.1/docs/index.html

### Key Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /workflows | List/search workflows |
| GET | /workflows/{id}/tasks | List tasks in a workflow template |
| POST | /workflow-runs | Create a workflow run |
| GET | /workflow-runs | Search workflow runs |
| GET | /workflow-runs/{id} | Get workflow run by ID |
| PUT | /workflow-runs/{id} | Update workflow run |
| DELETE | /workflow-runs/{id} | Delete workflow run |
| GET | /workflow-runs/{id}/tasks | List tasks in workflow run |
| GET | /workflow-runs/{id}/tasks/{taskId} | Get task |
| PUT | /workflow-runs/{id}/tasks/{taskId} | Update task (status, dueDate) |
| GET | /workflows/{id}/form-fields | List form field definitions for a workflow template |
| GET | /workflows/{id}/form-fields/{fieldId}/options | Get choices for a Select/MultiSelect field (see note below) |
| GET | /workflow-runs/{id}/form-fields | Get form field values for a workflow run |
| POST | /workflow-runs/{id}/form-fields | Update form field values (see Multi-Select note below) |
| POST | /webhooks | Create webhook (body: { url, triggers[], workflowId?, taskId? }) |
| DELETE | /webhooks/{id} | Delete webhook |

### Webhook Triggers Available

`TaskChecked`, `TaskUnchecked`, `TaskCheckedUnchecked`, `TaskReady`, `WorkflowRunCreated`, `WorkflowRunCompleted`

### Webhook URL Constraint (Key Discovery)

Process Street's `POST /webhooks` **rejects n8n's `/webhook-test/...` URLs** with a generic 400 "Your request is invalid or could not be processed by the service". This means the "Listen for test event" button in n8n does NOT work for the Process Street trigger — the webhook never gets registered.

To test the trigger, users must **activate the workflow** in n8n, which exposes the production `/webhook/{id}/webhook` URL. Process Street accepts that URL and fires real events against it.

The trigger node's `description` surfaces this so users see it in the node panel before hitting the wall. If you ever add a separate "test" affordance, it will need to go through Process Street's real event flow (or be mocked), not n8n's ephemeral test URL.

### API Response Keys

- `/workflows` returns `{ workflows: [...] }`
- `/workflow-runs` returns `{ workflowRuns: [...] }`
- `/workflows/{id}/form-fields` may return fields under `formFields` or `fields` key — handle both
- `/workflows/{id}/form-fields/{fieldId}/options` returns `{ options: [{ value, label, dataSetRowId? }] }` — paginated, same `links` pattern

### Form Field Options Endpoint (Key Discovery)

`GET /workflows/{workflowId}/form-fields/{fieldId}/options` retrieves the configured choices for Select and MultiSelect form fields. This endpoint:
- **Is not listed in the help docs** but exists in the official OpenAPI spec at `/api/v1.1/docs/openapi.json`
- Uses the same `X-API-Key` auth — no OAuth2 required
- Is paginated using the standard `links.find(l => l.name === 'next')?.href` pattern
- Returns `{ value, label }` pairs; use `label` as the display name and `value` as the submitted value
- Also returns `dataSetRowId` if the field's choices are sourced from a Data Set Saved View
- This is how Make.com populates dropdown choices in its Process Street integration

In `resourceMapping.ts`, call this endpoint for each `Select`/`Dropdown` field after listing all form fields, then pass the results as `options` on the `ResourceMapperField`. MultiSelect fields are excluded from the resource mapper and handled via a separate `multiOptions` parameter (see below). Hidden and File fields are included in the resource mapper as string inputs (Hidden stores a string value; File accepts a URL).

### Updating Form Field Values (Key Discovery: `value` vs `values`)

`POST /workflow-runs/{id}/form-fields` accepts `{ fields: [{ id, value?, values? }] }`.

- **Single-value fields** (Text, Email, Select, Date, Number, etc.) use the **`value`** key (singular, string):
  ```json
  {"id": "fieldId", "value": "some text"}
  ```
- **Multi-value fields** (MultiSelect, MultiChoice, Members) use the **`values`** key (plural, array of strings):
  ```json
  {"id": "fieldId", "values": ["Option A", "Option B"]}
  ```
- Using `value` (singular) for a MultiSelect field returns **400 Bad Request**. This is the most common mistake.
- The `values` array contains the **option label strings** (the display text from the `/options` endpoint).
- This is a **replace** operation — send ALL items you want checked. Items not in the array are unchecked.
- Both single-value and multi-value fields can be sent in the same request in the `fields` array.

### Due Date Validation (Key Discovery)

The Process Street API rejects `dueDate` values that are in the past **or** too close to "now" — empirically, anything inside roughly a 24-hour window returns a generic 400 `"Bad request - please check your parameters"` with no actionable detail. To give users a clear error instead, `ProcessStreet.node.ts` validates `dueDate` client-side via `validateFutureDueDate()` before POST `/workflow-runs` and PUT `/workflow-runs/{id}`:

- Parses the user-supplied ISO 8601 string with `new Date()`. ISO strings always carry their UTC offset (either `Z` or `±HH:MM`), so no timezone dropdown is needed — the resulting timestamp is unambiguous.
- Rejects NaN timestamps with a "not a valid ISO 8601" error.
- Requires the date to be at least `DUE_DATE_MIN_BUFFER_MS` (24h) ahead of `Date.now()`, otherwise throws a `NodeOperationError` that shows both the entered UTC time and the current UTC time.
- If a user legitimately needs a due date closer than 24h, relax the buffer or expose it as a node option — do not remove the validation entirely, as the API's 400 gives them nothing to debug.

The field descriptions in `WorkflowRunDescription.ts` include a Luxon expression example (`DateTime.now().setZone(...).plus({ days: N }).toUTC().toISO()`) so users entering local times know how to generate a correctly-offset ISO string.

### Form Field Definition Structure

Each form field from `GET /workflows/{id}/form-fields` has: `id`, `fieldType`, `key`, `taskId`, `audit`. Notable:
- `taskId` links the field to a specific workflow task (the task that contains this form field)
- `fieldType` values include: `Text`, `Textarea`, `Email`, `Select`, `MultiSelect`, `MultiChoice`, `Number`, `Date`, `File`, `SendRichEmail`, `Hidden`, `Subtasks`, `SubChecklist`, `Table`
- MultiSelect fields do NOT embed their options in the field definition — options must be fetched separately via the `/options` endpoint

### API Limitations

- No endpoints for comments or comment attachments in v1.1
- No webhook triggers for data set record changes (use polling)
- PUT /workflow-runs requires ALL fields (name, status, shared, dueDate) even if only updating one
- `dueDate` must be at least ~24h in the future; near-future dates return a generic 400. See "Due Date Validation" above.

### n8n Resource Mapper & MultiSelect UI Constraints

- **Resource mapper `type: 'array'`** with `options` does NOT render as a multi-select picker — it always renders as a raw JSON array textarea. Do NOT use it expecting a checkbox UI.
- **Resource mapper `type: 'options'`** renders a single-select dropdown. No multi-select type exists in the resource mapper.
- **MultiSelect fields are excluded from the resource mapper** and instead rendered as a top-level `multiOptions` parameter (`multiSelectValues`) which provides native n8n checkbox UI.
- The `multiOptions` loads ALL options from ALL MultiSelect fields via `getMultiSelectFieldOptions`, grouped by field name with disabled header separators. Values are encoded as `fieldId:::optionValue` so the execution handler can group them by field.
- **`loadOptionsDependsOn` does NOT work for sibling parameters inside a `fixedCollection`** — `getCurrentNodeParameter('siblingName')` returns `undefined` and `getCurrentNodeParameters()` also fails to expose siblings. This means cascading dropdowns inside fixedCollections are impossible in n8n. This is why MultiSelect uses a single flat `multiOptions` instead of a per-field fixedCollection.
- **`validateType: 'string'` in `typeOptions` is NOT supported** in n8n v2.x for `type: 'options'` fields. If a field needs to accept both a dropdown selection AND a raw ID via expression, use `type: 'string'` instead. The `options` type validates expression values against the loaded options list and rejects unknown values with "is not supported" errors.
- **URL-encode IDs in API calls** — always use `encodeURIComponent()` when embedding user-provided IDs in API endpoint URLs to handle special characters safely.

## n8n Node Development Constraints

- **No runtime dependencies**: `strict: true` in package.json means the `dependencies` field must be empty. Only `devDependencies` and `peerDependencies` are allowed.
- **n8n-workflow as peerDependency**: Never import from `n8n-core` directly; use `n8n-workflow` types and `this.helpers` methods.
- **Linter compliance**: Must pass n8n's ESLint rules. All node properties need `description`, trigger nodes need proper `group: ['trigger']`.
- **TypeScript only**: All source in `.ts` files.
- **Keyword required**: `n8n-community-node-package` must be in package.json keywords.
- **MIT license**: Required for community node verification.
- **npm provenance**: From May 2026, must publish via GitHub Actions with `--provenance` flag.

## Coding Conventions

- **Resource/Operation pattern**: Top-level `resource` dropdown, then `operation` per resource, with `displayOptions.show` to conditionally show fields.
- **Error handling**: Use `NodeApiError` for API failures, `NodeOperationError` for validation. Always check `this.continueOnFail()`.
- **Pagination**: Use `processStreetApiRequestAllItems()` from transport module for any list/search endpoint.
- **Dynamic dropdowns**: Use `typeOptions.loadOptionsMethod` pointing to functions in `methods/loadOptions.ts`. Use `loadOptionsDependsOn` for cascading dropdowns. In loadOptions methods, always use `getCurrentNodeParameter()` (not `getNodeParameter()`) to read sibling parameter values — `getNodeParameter` doesn't reliably resolve saved values when n8n reopens a node, causing dropdowns to show raw IDs instead of display names.
- **Paginated dropdowns**: All loadOptions functions (`getWorkflows`, `getTasks`, `getWorkflowFormFields`) use a `while` loop calling `this.helpers.httpRequestWithAuthentication` directly — **do not use a single `processStreetApiRequest` call**, as the API returns only 20 items per page and silently truncates. Pagination pattern confirmed by inspecting live API responses:
  ```ts
  let url: string | undefined = `https://public-api.process.st/api/v1.1/<endpoint>`;
  while (url) {
    const response = await this.helpers.httpRequestWithAuthentication.call(
      this, 'processStreetApi', { method: 'GET', url, json: true },
    );
    // collect response.<dataKey> items...
    const links = Array.isArray(response?.links) ? response.links : [];
    url = links.find((l: any) => l.name === 'next')?.href;
  }
  ```
  The next-page link has `name: "next"` and `type: "Api"`. The `rel` field is a resource-type label (e.g. `"Tasks"`) — never `"next"`. n8n caches loadOptions results, so after a code change you must restart n8n **and** switch to a different workflow (to bust the cache) before the dropdown re-fetches.
- **Update operation UI flow**: Workflow Name or ID (dropdown) → Run Name or ID (plain string, accepts pasted ID or expression) → Update Fields (metadata: name, status, dueDate, shared) → Form Fields (resource mapper, loads from selected workflow) → Multi-Select Values (multiOptions checkboxes). The form fields and multi-select sections are shared with Create and use the same `getFormFields` resource mapper and `getMultiSelectFieldOptions` loader, both keyed off `workflowId`. Only fields with values are sent — empty fields are skipped, preserving current values.
- **"Find or Create"**: Implement as a `searchBeforeCreate` boolean toggle on Create operations, not as a separate operation.
- **Webhook triggers**: Use `webhookMethods.default` with `checkExists`, `create`, `delete` methods. Store webhook ID in `this.getWorkflowStaticData('node')`.
- **Polling triggers**: Set `polling: true`, implement `poll()` method, store previous state in `getWorkflowStaticData('node')`. Include first-run guard. *(Note: the Data Set polling trigger was removed — data set functionality is not used in this package.)*

## Testing

1. `npm run build` - Must compile cleanly
2. `npm run lint` - Must pass all rules
3. Link to local n8n and test each operation manually
4. Verify credential test works with valid/invalid API keys
5. Verify webhook triggers create/delete webhooks on activation/deactivation
6. Verify poll triggers detect new/updated/deleted records

## Publishing

1. Update version in package.json
2. Create GitHub Release with tag (e.g., `v0.1.0`)
3. GitHub Actions workflow publishes to npm with provenance
4. Submit to n8n Creator Portal for community verification
