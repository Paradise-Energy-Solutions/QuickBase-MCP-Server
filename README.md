# QuickBase MCP Server

A Model Context Protocol (MCP) server that provides maximum flexibility for QuickBase operations. This server allows you to create tables, add fields, modify relationships, and perform all QuickBase operations through MCP tools.

## Features

### Application Management
- Get application information
- List all tables
- Test connection

### Table Operations
- Create new tables
- Get table information
- Update table properties
- Delete tables

### Field Management
- Get all fields for a table
- Create new fields (all types supported)
- Update existing fields
- Delete fields
- Support for lookups, formulas, relationships

### Record Operations
- Query records with filtering and sorting
- Get specific records
- Create single or multiple records
- Update existing records
- Delete records
- Search records by text
- Bulk operations

### Relationship Management
- Create parent-child relationships
- Get existing relationships
- Foreign key management

### Utility Functions
- Get and run reports
- Advanced querying capabilities
- Error handling and retry logic

## Installation

1. **Clone and setup the server:**
```bash
cd quickbase-mcp-server
npm install
```

> For CI/release builds, prefer `npm ci` (requires `package-lock.json`) for reproducible installs.

2. **Copy environment configuration:**
```bash
cp env.example .env
```

3. **Configure your QuickBase credentials in `.env`:**
```bash
# QuickBase Configuration
QB_REALM=yourname.quickbase.com
QB_USER_TOKEN=your_quickbase_user_token_here

# Optional: Default settings
QB_DEFAULT_TIMEOUT=30000
QB_MAX_RETRIES=3

# MCP Server Configuration
MCP_SERVER_NAME=quickbase-mcp
MCP_SERVER_VERSION=1.0.0

# Registered QuickBase Applications
# Add one block per app. The server discovers apps by scanning for QB_APP_<id>_NAME.
# At least one app must be registered; the server will not start without one.
#
# Finding your App ID:
#   Open the app in QuickBase. The URL will look like:
#   https://yourname.quickbase.com/db/bxxxxxxxxx
#   The alphanumeric segment after /db/ is the App ID (e.g. bxxxxxxxxx).
#
# Per-app safety flags (both default to the safe value if omitted):
#   QB_APP_<id>_READONLY          default: true   — blocks all write operations
#   QB_APP_<id>_ALLOW_DESTRUCTIVE default: false  — blocks delete operations

QB_APP_bxxxxxxxxx_NAME=My Primary App
QB_APP_bxxxxxxxxx_READONLY=false
QB_APP_bxxxxxxxxx_ALLOW_DESTRUCTIVE=false

QB_APP_byyyyyyyyyy_NAME=Archive (read-only)
QB_APP_byyyyyyyyyy_READONLY=true
QB_APP_byyyyyyyyyy_ALLOW_DESTRUCTIVE=false
```

4. **Build the project:**
```bash
npm run build
```

## Getting Your QuickBase User Token

1. Go to QuickBase → My Apps → User Account
2. Click "Manage user tokens"
3. Click "New user token"
4. Give it a name like "MCP Server"
5. Set appropriate permissions
6. Copy the token to your `.env` file

## Usage

### Run the server standalone:
```bash
npm start
```

### Add to your MCP client configuration:

Add to your MCP client configuration (e.g., Claude Desktop `claude_desktop_config.json`, or VS Code `mcp.json`).

App registration is read from the `.env` file in the server's package directory. Only `QB_REALM` and `QB_USER_TOKEN` need to appear in the client config — all app entries are loaded from `.env`.

**VS Code `mcp.json` (recommended — uses OS credential store for token):**
```json
{
  "inputs": [
    {
      "id": "qb_user_token",
      "type": "promptString",
      "description": "QuickBase user token",
      "password": true
    }
  ],
  "servers": {
    "quickbase": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/QuickBase-MCP-Server/dist/index.js"],
      "env": {
        "QB_REALM": "yourname.quickbase.com",
        "QB_USER_TOKEN": "${input:qb_user_token}"
      }
    }
  }
}
```

**Claude Desktop `claude_desktop_config.json`:**
```json
{
  "mcpServers": {
    "quickbase": {
      "command": "node",
      "args": ["/path/to/QuickBase-MCP-Server/dist/index.js"],
      "env": {
        "QB_REALM": "yourname.quickbase.com",
        "QB_USER_TOKEN": "your_token_here"
      }
    }
  }
}
```

> **Security note:** Do not paste your token directly into the VS Code `mcp.json` file if Settings Sync is enabled, as that file is uploaded to the cloud. Use the `password: true` input pattern shown above instead.

## Available Tools

### Application Tools
- `quickbase_list_apps` - List all apps registered in this server's `.env` (call this first to discover `appId` values)
- `quickbase_get_app_info` - Get live application metadata from QuickBase
- `quickbase_get_tables` - List all tables in an app
- `quickbase_test_connection` - Test connection to an app

> **All tools (except `quickbase_list_apps`) require an `appId` parameter.** Call `quickbase_list_apps` first to see registered apps and their IDs.

### Table Tools
- `quickbase_create_table` - Create new table
- `quickbase_get_table_info` - Get table details
- `quickbase_delete_table` - Delete table

### Field Tools
- `quickbase_get_table_fields` - Get all fields
- `quickbase_create_field` - Create new field
- `quickbase_update_field` - Update existing field
- `quickbase_delete_field` - Delete field

### Record Tools
- `quickbase_query_records` - Query with filters/sorting
- `quickbase_get_record` - Get specific record
- `quickbase_create_record` - Create new record
- `quickbase_update_record` - Update existing record
- `quickbase_delete_record` - Delete record
- `quickbase_bulk_create_records` - Create multiple records
- `quickbase_search_records` - Search by text

### Relationship Tools
- `quickbase_create_relationship` - Create table relationship
- `quickbase_get_relationships` - Get existing relationships

### Utility Tools
- `quickbase_get_reports` - Get all reports
- `quickbase_run_report` - Run specific report

## Example Usage

### List registered apps (always start here):
```json
{
  "name": "quickbase_list_apps",
  "arguments": {}
}
```

### Create a new table:
```json
{
  "name": "quickbase_create_table",
  "arguments": {
    "appId": "bxxxxxxxxx",
    "name": "New Projects",
    "description": "Project tracking table"
  }
}
```

### Add a field to a table:
```json
{
  "name": "quickbase_create_field",
  "arguments": {
    "appId": "bxxxxxxxxx",
    "tableId": "your_table_id_here",
    "label": "Project Status",
    "fieldType": "text_choice",
    "choices": ["Planning", "Active", "Complete", "On Hold"],
    "required": true
  }
}
```

### Query records with filtering:
```json
{
  "name": "quickbase_query_records",
  "arguments": {
    "appId": "bxxxxxxxxx",
    "tableId": "your_table_id_here",
    "where": "{6.EX.'John'}",
    "top": 10,
    "sortBy": [{"fieldId": 3, "order": "DESC"}]
  }
}
```

### Create a new record:
```json
{
  "name": "quickbase_create_record",
  "arguments": {
    "appId": "bxxxxxxxxx",
    "tableId": "your_table_id_here",
    "fields": {
      "6": {"value": "John Doe"},
      "7": {"value": "123 Main St"},
      "8": {"value": "john@example.com"}
    }
  }
}
```

## Field Types Supported

- `text` - Single line text
- `text_choice` - Single choice dropdown
- `text_multiline` - Multi-line text
- `richtext` - Rich text editor
- `numeric` - Number field
- `currency` - Currency field
- `percent` - Percentage field
- `date` - Date field
- `datetime` - Date/time field
- `checkbox` - Checkbox field
- `email` - Email field
- `phone` - Phone number field
- `url` - URL field
- `address` - Address field
- `file` - File attachment
- `lookup` - Lookup from another table
- `formula` - Calculated field
- `reference` - Table reference

## Development

### Run in development mode:
```bash
npm run dev
```

### Run tests:

#### Unit Tests (with Coverage)
```bash
npm run test:unit
```

Runs 154 comprehensive unit tests with **78.62% code coverage**, exceeding the 70% target. Tests cover:
- All Zod schema validation (100% coverage)
- Tool definitions and schemas (100% coverage)
- Client methods and utilities (89.79% coverage)
- Error handling and edge cases

For more information, see [TESTING.md](TESTING.md).

#### Watch Mode (Development)
```bash
npm run test:unit:watch
```

Run tests in watch mode for continuous feedback during development.

#### Smoke Test
```bash
npm test
```

Quick smoke test that verifies tools are loaded correctly (runs before publishing).

#### Integration Test
To run the QuickBase integration test (requires `QB_REALM`, `QB_USER_TOKEN`, and at least one `QB_APP_<id>_NAME` entry in `.env`):
```bash
npm run test:integration
```

## Troubleshooting

### Common Issues

1. **"No QuickBase apps registered" on startup**
   - Your `.env` file has no `QB_APP_<id>_NAME` entries
   - Run `setup.js` again, or add entries manually (see `.env` configuration above)
   - Make sure the `.env` file is in the server package root directory

2. **`Unknown appId` error when calling a tool**
   - The `appId` you passed is not in the registry
   - Call `quickbase_list_apps` to see valid IDs
   - Add the app to `.env` and restart the server

3. **Finding App IDs**
   - Open the app in QuickBase in your browser
   - The URL will be: `https://yourname.quickbase.com/db/bxxxxxxxxx`
   - The alphanumeric segment after `/db/` is the App ID

4. **Authentication Error**
   - Check your user token is correct in `.env` and/or your MCP client config
   - Verify the token has permissions for each registered app
   - Ensure the realm hostname is correct (no `https://` prefix)

5. **Table/Field Not Found**
   - Verify table/field IDs are correct
   - Check you have permission to access the table

6. **Field Creation Fails**
   - Check field type is supported
   - Verify choices are provided for choice fields
   - Ensure formula syntax is correct for formula fields

### Enable Debug Logging
```bash
DEBUG=quickbase-mcp:*
```

To enable QuickBase API request/response logs (off by default):
```bash
QB_LOG_API=true
```

## Implementation Notes

This server provides the maximum flexibility for QuickBase operations by:

1. **Multi-App Support** - Register unlimited QuickBase apps in `.env`; switch between them per tool call via `appId`
2. **Per-App Safety Controls** - Each app independently configures `READONLY` and `ALLOW_DESTRUCTIVE` flags; unknown apps always default to the strictest safe settings
3. **Lazy Client Caching** - QuickBase API clients are created on first use and cached for the lifetime of the server process; no redundant connections
4. **Direct API Access** - Uses QuickBase REST API v1 directly
5. **Complete Field Support** - Supports all QuickBase field types
6. **Relationship Management** - Can create and manage table relationships
7. **Bulk Operations** - Efficient bulk record operations
8. **Advanced Querying** - Full QuickBase query syntax support
9. **Error Handling** - Comprehensive error handling and retry logic

## License

MIT License 
