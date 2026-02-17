import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import axios from "axios";
import { createServer } from "http";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// ─── ConnectWise Config ───────────────────────────────────────────────────────
const CW_BASE_URL   = process.env.CW_BASE_URL   || "https://na.myconnectwise.net";
const CW_COMPANY_ID = process.env.CW_COMPANY_ID || "ntm";
const CW_PUBLIC_KEY = process.env.CW_PUBLIC_KEY;
const CW_PRIVATE_KEY= process.env.CW_PRIVATE_KEY;
const CW_CLIENT_ID  = process.env.CW_CLIENT_ID;
const API_VERSION   = "v4_6_release";

if (!CW_PUBLIC_KEY || !CW_PRIVATE_KEY || !CW_CLIENT_ID) {
  console.error("Missing required env vars: CW_PUBLIC_KEY, CW_PRIVATE_KEY, CW_CLIENT_ID");
  process.exit(1);
}

// ─── Auth Header ─────────────────────────────────────────────────────────────
function getAuthHeaders() {
  const token = Buffer.from(`${CW_COMPANY_ID}+${CW_PUBLIC_KEY}:${CW_PRIVATE_KEY}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "Content-Type": "application/json",
    clientId: CW_CLIENT_ID,
    Accept: "application/json",
  };
}

// ─── CW API Helper ────────────────────────────────────────────────────────────
async function cwRequest(method, path, params = {}, data = null) {
  const url = `${CW_BASE_URL}/${API_VERSION}/apis/3.0${path}`;
  try {
    const res = await axios({
      method,
      url,
      headers: getAuthHeaders(),
      params: method === "GET" ? params : undefined,
      data: method !== "GET" ? data : undefined,
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`CW API Error [${err.response?.status}]: ${msg}`);
  }
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
// A new McpServer instance must be created per HTTP request — the MCP SDK does
// not allow a single instance to connect to multiple transports.
function createMcpServer() {
  const server = new McpServer({
    name: "connectwise-mcp",
    version: "1.0.0",
  });

  // ══════════════════════════════════════════════════════════════════════════════
  //  SERVICE TICKETS
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_tickets",
    "Search and list ConnectWise service tickets",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "status/name=\'New\' AND priority/name=\'High\'"'),
      pageSize:   z.number().optional().describe("Number of tickets to return (default 25, max 1000)"),
      page:       z.number().optional().describe("Page number for pagination"),
      orderBy:    z.string().optional().describe('Sort order e.g. "id desc"'),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/service/tickets", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_ticket",
    "Get a single ConnectWise service ticket by ID",
    { ticketId: z.number().describe("The ticket ID") },
    async ({ ticketId }) => {
      const data = await cwRequest("GET", `/service/tickets/${ticketId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_ticket",
    "Create a new ConnectWise service ticket",
    {
      summary:            z.string().describe("Ticket summary/subject"),
      companyId:          z.number().describe("Company ID to associate the ticket with"),
      boardId:            z.number().optional().describe("Service board ID"),
      statusId:           z.number().optional().describe("Status ID"),
      priorityId:         z.number().optional().describe("Priority ID"),
      contactId:          z.number().optional().describe("Contact ID"),
      initialDescription: z.string().optional().describe("Initial ticket description/notes"),
      typeId:             z.number().optional().describe("Ticket type ID"),
      subTypeId:          z.number().optional().describe("Ticket subtype ID"),
    },
    async ({ summary, companyId, boardId, statusId, priorityId, contactId, initialDescription, typeId, subTypeId }) => {
      const body = {
        summary,
        company: { id: companyId },
        ...(boardId    && { board:    { id: boardId } }),
        ...(statusId   && { status:   { id: statusId } }),
        ...(priorityId && { priority: { id: priorityId } }),
        ...(contactId  && { contact:  { id: contactId } }),
        ...(initialDescription && { initialDescription }),
        ...(typeId     && { type:     { id: typeId } }),
        ...(subTypeId  && { subType:  { id: subTypeId } }),
      };
      const data = await cwRequest("POST", "/service/tickets", {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_ticket",
    "Update a ConnectWise service ticket",
    {
      ticketId:   z.number().describe("Ticket ID to update"),
      summary:    z.string().optional().describe("New summary"),
      statusId:   z.number().optional().describe("New status ID"),
      priorityId: z.number().optional().describe("New priority ID"),
      assignedTo: z.string().optional().describe("Member identifier to assign to"),
    },
    async ({ ticketId, summary, statusId, priorityId, assignedTo }) => {
      const ops = [];
      if (summary)    ops.push({ op: "replace", path: "/summary",          value: summary });
      if (statusId)   ops.push({ op: "replace", path: "/status/id",        value: statusId });
      if (priorityId) ops.push({ op: "replace", path: "/priority/id",      value: priorityId });
      if (assignedTo) ops.push({ op: "replace", path: "/owner/identifier", value: assignedTo });
      const data = await cwRequest("PATCH", `/service/tickets/${ticketId}`, {}, ops);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_ticket_notes",
    "Get all notes/discussions for a ConnectWise ticket",
    { ticketId: z.number().describe("The ticket ID") },
    async ({ ticketId }) => {
      const data = await cwRequest("GET", `/service/tickets/${ticketId}/notes`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "add_ticket_note",
    "Add a note to a ConnectWise service ticket",
    {
      ticketId:          z.number().describe("The ticket ID"),
      text:              z.string().describe("Note text content"),
      internalFlag:      z.boolean().optional().describe("True = internal note, False = external/customer visible"),
      detailDescription: z.boolean().optional().describe("Add as detail description"),
    },
    async ({ ticketId, text, internalFlag, detailDescription }) => {
      const body = {
        text,
        internalFlag:      internalFlag ?? true,
        detailDescription: detailDescription ?? false,
      };
      const data = await cwRequest("POST", `/service/tickets/${ticketId}/notes`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  COMPANIES
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_companies",
    "Search and list ConnectWise companies",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "name like \'Acme%\'"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/company/companies", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_company",
    "Get a single ConnectWise company by ID",
    { companyId: z.number().describe("The company ID") },
    async ({ companyId }) => {
      const data = await cwRequest("GET", `/company/companies/${companyId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  CONTACTS
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_contacts",
    "Search and list ConnectWise contacts",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "company/id=123"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ conditions, pageSize, page }) => {
      const data = await cwRequest("GET", "/company/contacts", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_contact",
    "Get a single ConnectWise contact by ID",
    { contactId: z.number().describe("The contact ID") },
    async ({ contactId }) => {
      const data = await cwRequest("GET", `/company/contacts/${contactId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  TIME ENTRIES
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_time_entries",
    "Get time entries from ConnectWise",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "chargeToId=1234 AND chargeToType=\'ServiceTicket\'"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ conditions, pageSize, page }) => {
      const data = await cwRequest("GET", "/time/entries", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "add_time_entry",
    "Log a time entry in ConnectWise",
    {
      chargeToId:   z.number().describe("Ticket or project ID to log time against"),
      chargeToType: z.enum(["ServiceTicket", "ProjectTicket", "ChargeCode", "Activity"]).describe("Type of record to charge time to"),
      timeStart:    z.string().describe("Start time in ISO 8601 format e.g. 2025-01-15T09:00:00Z"),
      timeEnd:      z.string().describe("End time in ISO 8601 format"),
      notes:        z.string().optional().describe("Notes about the work performed"),
      memberId:     z.number().optional().describe("Member ID (defaults to API user)"),
      workTypeId:   z.number().optional().describe("Work type ID"),
    },
    async ({ chargeToId, chargeToType, timeStart, timeEnd, notes, memberId, workTypeId }) => {
      const body = {
        chargeToId,
        chargeToType,
        timeStart,
        timeEnd,
        ...(notes      && { notes }),
        ...(memberId   && { member:   { id: memberId } }),
        ...(workTypeId && { workType: { id: workTypeId } }),
      };
      const data = await cwRequest("POST", "/time/entries", {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  PROJECTS
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_projects",
    "Search and list ConnectWise projects",
    {
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ conditions, pageSize, page }) => {
      const data = await cwRequest("GET", "/project/projects", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_project",
    "Get a single ConnectWise project by ID",
    { projectId: z.number().describe("The project ID") },
    async ({ projectId }) => {
      const data = await cwRequest("GET", `/project/projects/${projectId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  AGREEMENTS
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_agreements",
    "Search and list ConnectWise agreements",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "company/id=123"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ conditions, pageSize, page }) => {
      const data = await cwRequest("GET", "/finance/agreements", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  MEMBERS / SYSTEM
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_members",
    "Get ConnectWise members (technicians/staff)",
    {
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
    },
    async ({ conditions, pageSize }) => {
      const data = await cwRequest("GET", "/system/members", {
        conditions,
        pageSize: pageSize || 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_service_boards",
    "Get all ConnectWise service boards",
    {},
    async () => {
      const data = await cwRequest("GET", "/service/boards", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_priorities",
    "Get all ConnectWise ticket priorities",
    {},
    async () => {
      const data = await cwRequest("GET", "/service/priorities", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_statuses",
    "Get ticket statuses for a service board",
    { boardId: z.number().describe("The service board ID") },
    async ({ boardId }) => {
      const data = await cwRequest("GET", `/service/boards/${boardId}/statuses`, { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRANSPORT — stdio (local) or HTTP (Railway)
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT;

if (PORT) {
  // Railway / hosted mode — StreamableHTTP
  // A fresh McpServer is created for each request to avoid the
  // "Already connected to a transport" error from the MCP SDK.
  const httpServer = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", server: "connectwise-mcp" }));
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  });

  httpServer.listen(PORT, () => {
    console.log(`ConnectWise MCP server running on port ${PORT}`);
  });
} else {
  // Local / stdio mode
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ConnectWise MCP server running on stdio");
}

// Helper: read raw request body
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}
