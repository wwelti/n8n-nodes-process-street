# n8n-nodes-process-street

This is an n8n community node for [Process Street](https://www.process.st/) — a workflow automation platform for recurring checklists and processes.

[n8n](https://n8n.io/) is a fair-code licensed workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Credentials

You need a Process Street API Key to use this node:

1. Log in to your Process Street account
2. Go to **Settings > API Keys**
3. Create a new API key
4. Copy the key and use it when creating Process Street credentials in n8n

## Operations

### Workflow Run

| Operation | Description |
|-----------|-------------|
| Create | Create a new workflow run (optionally search for existing first) |
| Delete | Delete a workflow run |
| Find | Search for workflow runs by name, status, or workflow |
| Get | Get a workflow run by ID |
| Update | Update a workflow run's name, status, due date, or sharing |

## Triggers

### Process Street Trigger (Webhook)

Real-time triggers powered by Process Street webhooks:

- **Task Checked** — when a task is checked off
- **Task Ready** — when a task is ready to be worked on
- **Workflow Run Completed** — when a workflow run is completed
- **Workflow Run Created** — when a new workflow run is created

## Known Limitations

- **Comment triggers** (New Comment, New Comment Attachment) are not supported because the Process Street v1.1 API does not expose comment endpoints or webhook triggers for comments.
- The **Update Workflow Run** operation fetches the current state before updating because the Process Street API requires all fields on PUT requests.
- **Due Date** on Create and Update must be at least 24 hours in the future. The Process Street API rejects near-future dates with a generic 400 error, so the node validates client-side and returns a clear message instead. If you're entering a local time, use a Luxon expression (example is provided in the Due Date field description) to produce a correctly-offset ISO 8601 string.

## Compatibility

- Requires n8n version 1.0.0 or later
- Uses n8n Nodes API version 1

## Resources

- [Process Street API Documentation](https://public-api.process.st/api/v1.1/docs/index.html)
- [n8n Community Nodes Documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE)
