# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Pipeline relay is now one shared background daemon** (`dist/relay/daemon.js`) instead of a server inside every MCP process. Previously each Claude session started its own relay and the newest one took the port, so only the most recently started session's Pipeline tools worked. Now every session talks to the single daemon over authenticated loopback HTTP, the first session to start the MCP server starts it (detached, so it should survive sessions closing), and you click the bookmarklet once per browser tab. An already-open Pipelines tab re-attaches by itself if the daemon restarts; the bookmarklet itself is unchanged.
- Pipeline impersonation is serialised across sessions by an exclusive lock held from start to end (with a TTL; an abandoned impersonation is ended by the daemon), so one session's call can no longer run as another's identity.
- The relay no longer shuts down whatever holds its port. A healthy daemon is never stopped by a newcomer; an older daemon is replaced only when idle, and an active old-build relay only with `QB_RELAY_REPLACE_LEGACY=true`.
- New commands `npm run relay:start`, `relay:stop` and `relay:status`; new settings `QB_RELAY_IDLE_MINUTES`, `QB_RELAY_STATE_DIR`, `QB_RELAY_LOCK_TTL_SECONDS`, `QB_RELAY_LOCK_WAIT_SECONDS` and `QB_RELAY_REPLACE_LEGACY` (see `env.example` and the README).

### Security
- Relay requests are validated before they can be queued: the path must start with `/api/` and contain no `//`, `..`, `@`, backslash, scheme or non-ASCII characters, so the bookmarklet's CSRF token cannot be steered to another host.
- Every relay endpoint now checks the `Host` header (DNS rebinding); `/relay/hello` and `/relay/pending` also require the QuickBase origin and a CORS-mode fetch (previously only `/relay/result` did).
- The daemon's control API requires a per-user secret (owner-only file, constant-time compare) and refuses any request carrying an `Origin` or `Sec-Fetch-*` header. The daemon is started with only relay settings in its environment, never `QB_USER_TOKEN`.

### Fixed
- A relay request that timed out while still queued could later run in the browser anyway; it is now withdrawn.
- A dropped bookmarklet connection (closed or reloaded tab) no longer swallows the next request.

## [1.0.0] - 2024-12-11

### Added
- Initial release of QuickBase MCP Server
- Comprehensive QuickBase API integration
- Application management tools (get info, list tables, test connection)
- Table operations (create, read, update, delete)
- Field management (all field types supported including lookups and formulas)
- Record operations (query, create, update, delete, bulk operations)
- Relationship management (create and get relationships)
- Report tools (get reports, run reports)
- Advanced querying with filtering and sorting
- Text search capabilities
- Error handling and retry logic
- TypeScript support with full type definitions
- Comprehensive documentation and examples
- MIT license for open source use

### Features
- **Full QuickBase API Coverage**: Supports all major QuickBase operations
- **Type Safety**: Complete TypeScript definitions for all tools and responses
- **Error Handling**: Robust error handling with automatic retries
- **Flexible Configuration**: Easy setup with environment variables
- **Production Ready**: Tested and optimized for production use
- **Developer Friendly**: Clear documentation and examples

### Tools Available
- `quickbase_get_app_info` - Get application information
- `quickbase_get_tables` - List all tables in application
- `quickbase_test_connection` - Test QuickBase connection
- `quickbase_create_table` - Create new table
- `quickbase_get_table_info` - Get table details
- `quickbase_delete_table` - Delete table
- `quickbase_get_table_fields` - Get all fields for a table
- `quickbase_create_field` - Create new field (all types supported)
- `quickbase_update_field` - Update existing field
- `quickbase_delete_field` - Delete field
- `quickbase_query_records` - Query records with filtering/sorting
- `quickbase_get_record` - Get specific record
- `quickbase_create_record` - Create new record
- `quickbase_update_record` - Update existing record
- `quickbase_delete_record` - Delete record
- `quickbase_bulk_create_records` - Create multiple records
- `quickbase_search_records` - Search records by text
- `quickbase_create_relationship` - Create table relationship
- `quickbase_get_relationships` - Get existing relationships
- `quickbase_get_reports` - Get all reports
- `quickbase_run_report` - Run specific report

### Supported Field Types
- Text, Text Choice, Multi-line Text, Rich Text
- Numeric, Currency, Percent
- Date, DateTime
- Checkbox, Email, Phone, URL, Address
- File Attachment
- Lookup, Formula, Reference

## [Unreleased]

### Planned
- Enhanced bulk operations
- Advanced relationship management
- Custom field validation
- Performance optimizations
- Additional utility functions 