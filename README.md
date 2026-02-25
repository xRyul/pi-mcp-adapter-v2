# Pi MCP Adapter v2
> Fork of https://github.com/nicobailon/pi-mcp-adapter (original by Nico Bailon).

## What's different

- Cell rendering e.g.: thoughts of Sequential Thinking MCP
- All in Single Modal via `/mcp` 
	- Add/edit/remove MCP servers directly from the modal (modifies global config: `~/.pi/agent/mcp.json`) e.g.:
      - Add:  
        <img width="450" alt="Add" src="https://github.com/user-attachments/assets/817250da-dc26-4470-9ad0-19d76e5d5c00" />  
      - Edit:  
        <img width="450" alt="Edit" src="https://github.com/user-attachments/assets/3dbdeacc-364b-422c-903e-4e4060faf887" />  
	- Unified all commands (`/mcp reconnect`, `/mcp status`, `/mcp-auth` ..) under single `/mcp`
	- Hot reload


