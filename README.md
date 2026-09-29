# Pi MCP Adapter v2
> Fork of https://github.com/nicobailon/pi-mcp-adapter (original by Nico Bailon).

## What's different

- Collapsed MCP output: successful results stay hidden; **Ctrl+O** expands them. Errors remain visible.

  | Before (v2.4.5) | After (v2.4.6) |
  | --- | --- |
  | <img width="450" alt="Before: collapsed MCP call still shows output" src="https://github.com/xRyul/pi-mcp-adapter-v2/releases/download/v2.4.6/mcp-before-v2.4.5.png" /> | <img width="450" alt="After: collapsed MCP call shows only its header" src="https://github.com/xRyul/pi-mcp-adapter-v2/releases/download/v2.4.6/mcp-after-v2.4.6.png" /> |

- Cell rendering e.g.: thoughts of Sequential Thinking MCP
- All in Single Modal via `/mcp` 
	- Add/edit/remove MCP servers directly from the modal (modifies global config: `~/.pi/agent/mcp.json`) e.g.:
      - Add:  
        <img width="450" alt="Add" src="https://github.com/user-attachments/assets/817250da-dc26-4470-9ad0-19d76e5d5c00" />  
      - Edit:  
        <img width="450" alt="Edit" src="https://github.com/user-attachments/assets/3dbdeacc-364b-422c-903e-4e4060faf887" />  
	- Unified all commands (`/mcp reconnect`, `/mcp status`, `/mcp-auth` ..) under single `/mcp`
	- Hot reload


