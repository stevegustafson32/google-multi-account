# Privacy Policy — Google Multi-Account Plugin

**Last updated:** April 13, 2026

## Overview

The Google Multi-Account plugin ("the Plugin") is an open-source MCP (Model Context Protocol) server that enables Claude to interact with Gmail and Google Calendar on behalf of the user. This privacy policy describes what data the Plugin accesses, how it is handled, and the controls available to users.

## Data Collection and Storage

### What the Plugin Does NOT Do

- Does not collect, transmit, or store user data on any external server
- Does not send data to any third party, analytics service, or telemetry endpoint
- Does not retain email content, calendar events, or personal information beyond the active session
- Does not store conversation history or query logs
- Does not create user profiles or track usage patterns
- Does not use data for advertising, model training, or any secondary purpose

### What the Plugin Stores Locally

The Plugin stores the following files exclusively on the user's local machine at `~/.google-multi-mcp/`:

| File | Contents | Purpose |
|------|----------|---------|
| `config.json` | Account labels and Google OAuth client ID/secret | Routes requests to the correct Google account |
| `.tokens.json` | OAuth 2.0 refresh tokens and access tokens | Authenticates API requests to Google on the user's behalf |

These files are never transmitted off-device. They reside solely in the user's home directory and are only read by the local MCP server process.

## Authentication and Authorization

### OAuth 2.0 Scopes

The Plugin requests the following Google OAuth 2.0 scopes, which represent the minimum permissions required for its functionality:

- `https://www.googleapis.com/auth/gmail.modify` — Read, send, draft, and label emails
- `https://www.googleapis.com/auth/calendar` — Read and write calendar events
- `https://www.googleapis.com/auth/calendar.readonly` — Read calendar availability

### User Consent

- Users explicitly authenticate each Google account through Google's standard OAuth 2.0 consent flow
- Google displays the requested scopes and the user must grant permission before any access is provided
- Users authenticate against their own Google Cloud Platform (GCP) project, meaning Anthropic and the Plugin author have zero access to user credentials or tokens
- Users can revoke access at any time via [Google Account Permissions](https://myaccount.google.com/permissions)

## Data Flow Architecture
All processing occurs locally. The MCP server runs as a local process on the user's machine. API calls go directly from the user's machine to Google's servers using the user's own credentials. No intermediate servers, proxies, or relays are involved.

## Data Handling During Sessions

- Email content and calendar data retrieved from Google APIs are passed to Claude's local context for the duration of the conversation
- This data is subject to Anthropic's own data handling and privacy policies as part of the Claude session
- The Plugin itself does not cache, log, or persist any API response data to disk
- When the Claude session ends, no Plugin-side residual data remains beyond the stored credentials listed above

## Third-Party Services

The Plugin interacts with the following third-party services:

| Service | Purpose | Governed by |
|---------|---------|-------------|
| Google Gmail API | Email operations (search, read, draft, send, label) | [Google Privacy Policy](https://policies.google.com/privacy) |
| Google Calendar API | Calendar operations (list, create, update, find free time) | [Google Privacy Policy](https://policies.google.com/privacy) |
| Anthropic Claude | AI assistant that invokes the Plugin's tools | [Anthropic Privacy Policy](https://www.anthropic.com/privacy) |

The Plugin author does not operate any backend service, database, or data pipeline.

## Security Measures

- **Local-only execution**: The MCP server runs entirely on the user's machine with no network listeners or open ports
- **No hardcoded credentials**: All OAuth credentials are user-supplied from the user's own GCP project
- **Token isolation**: Refresh tokens are stored in a dotfile (`.tokens.json`) in the user's home directory with standard filesystem permissions
- **No logging of sensitive data**: The server does not log email content, calendar details, or token values
- **Open source**: The complete source code is available for inspection at [github.com/stevegustafson32/google-multi-account](https://github.com/stevegustafson32/google-multi-account)

## User Rights and Controls

Users have full control over their data at all times:

- **Revoke access**: Remove the Plugin's access to any Google account via [Google Account Permissions](https://myaccount.google.com/permissions)
- **Delete local data**: Remove all stored credentials by deleting `~/.google-multi-mcp/config.json` and `~/.google-multi-mcp/.tokens.json`
- **Uninstall**: Remove the Plugin entirely by deleting the `~/.google-multi-mcp/` directory and removing the server entry from Claude's desktop configuration
- **Inspect**: Review the complete source code and verify data handling behavior

## Children's Privacy

The Plugin is not directed at children under 13 and does not knowingly process data from children.

## Changes to This Policy

Updates to this privacy policy will be reflected in the Plugin's GitHub repository with an updated "Last updated" date. Users are encouraged to review this policy periodically.

## Contact

For questions about this privacy policy or the Plugin's data practices:

- **Email**: stevegustafson@gmail.com
- **GitHub Issues**: [github.com/stevegustafson32/google-multi-account/issues](https://github.com/stevegustafson32/google-multi-account/issues)
