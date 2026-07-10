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
      ticketId:     z.number().describe("The ticket ID"),
      text:         z.string().describe("Note text content"),
      internalFlag: z.boolean().optional().describe("True = internal note, False = external/customer visible"),
      noteType:     z.enum(["discussion", "internal", "detail", "resolution"]).optional().describe("Tab to post to: discussion (default), internal (Internal Analysis), detail (Detail Description), resolution (Resolution)"),
    },
    async ({ ticketId, text, internalFlag, noteType }) => {
      const type = noteType ?? (internalFlag === true ? "internal" : "discussion");
      const body = {
        text,
        ...(type === "detail"      && { detailDescriptionFlag: true }),
        ...(type === "internal"    && { internalAnalysisFlag: true }),
        ...(type === "resolution"  && { resolutionFlag: true }),
        ...(type === "discussion"  && { detailDescriptionFlag: true }),
      };
      const data = await cwRequest("POST", `/service/tickets/${ticketId}/notes`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  SERVICE TEMPLATES & TASK TEMPLATES
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_service_templates",
    "Search and list ConnectWise service ticket templates (reusable ticket blueprints bound to a board). Use to find a template's ID before adding task templates.",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "board/id=34"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/service/templates", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_service_template",
    "Create a ConnectWise service ticket template. A template is bound to a service board (e.g. Support Tier1 = board 34). After creating it, use create_service_template_task to add the checklist tasks that get applied to tickets.",
    {
      name:         z.string().describe("Template name (max 100 chars)"),
      boardId:      z.number().describe("Service board ID this template belongs to (e.g. 34 for Support Tier1)"),
      statusId:     z.number().describe("Default status ID for tickets created from this template (use get_statuses)"),
      summary:      z.string().describe("Default ticket summary (max 100 chars)"),
      typeId:       z.number().optional().describe("Default ticket type ID"),
      subTypeId:    z.number().optional().describe("Default ticket subtype ID"),
      itemId:       z.number().optional().describe("Default ticket item ID"),
      priorityId:   z.number().optional().describe("Default priority ID"),
      problem:      z.string().optional().describe("Default initial/problem description"),
      templateFlag: z.boolean().optional().describe("Mark as a reusable ticket template (default behavior for /service/templates records)"),
    },
    async ({ name, boardId, statusId, summary, typeId, subTypeId, itemId, priorityId, problem, templateFlag }) => {
      const body = {
        name,
        board:  { id: boardId },
        status: { id: statusId },
        summary,
        ...(typeId     && { type:     { id: typeId } }),
        ...(subTypeId  && { subtype:  { id: subTypeId } }),
        ...(itemId     && { item:     { id: itemId } }),
        ...(priorityId && { priority: { id: priorityId } }),
        ...(problem    && { problem }),
        ...(templateFlag !== undefined && { templateFlag }),
      };
      const data = await cwRequest("POST", "/service/templates", {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_service_template_tasks",
    "Get the task templates (checklist items) belonging to a ConnectWise service ticket template",
    {
      templateId: z.number().describe("The parent service template ID"),
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ templateId, conditions, pageSize, page }) => {
      const data = await cwRequest("GET", `/service/templates/${templateId}/tasks`, {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_service_template_task",
    "Add a task template (checklist item) to a ConnectWise service ticket template. Each task becomes a ticket task when the template is applied. Call once per task.",
    {
      templateId: z.number().describe("The parent service template ID (use create_service_template or get_service_templates)"),
      priority:   z.number().describe("Task order/sequence number (lower = earlier)"),
      notes:      z.string().describe("The task text/description shown on the ticket"),
      codeId:     z.number().optional().describe("Service code ID to associate with the task"),
    },
    async ({ templateId, priority, notes, codeId }) => {
      const body = {
        priority,
        notes,
        ...(codeId && { code: { id: codeId } }),
      };
      const data = await cwRequest("POST", `/service/templates/${templateId}/tasks`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_board_auto_templates",
    "Get the auto-template rules for a service board (which service template auto-applies for a given Type/SubType/Item combination)",
    {
      boardId:    z.number().describe("The service board ID (e.g. 34 for Support Tier1)"),
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ boardId, conditions, pageSize, page }) => {
      const data = await cwRequest("GET", `/service/boards/${boardId}/autoTemplates`, {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_board_auto_template",
    "Configure a service board to auto-apply a service template (and its task templates) when a ticket matches a Type/SubType/Item combination. This is what makes task templates fire automatically on the board.",
    {
      boardId:                 z.number().describe("The service board ID (e.g. 34 for Support Tier1)"),
      typeId:                  z.number().describe("Ticket type ID that triggers the template"),
      subTypeId:               z.number().describe("Ticket subtype ID that triggers the template"),
      itemId:                  z.number().describe("Ticket item ID that triggers the template"),
      templateId:              z.number().describe("The service template ID to apply (use get_service_templates)"),
      summarySetting:          z.enum(["Append", "Overwrite", "Ignore"]).optional().describe("How to merge the summary (default Ignore)"),
      discussionSetting:       z.enum(["Append", "Overwrite", "Ignore"]).optional().describe("How to merge the discussion note"),
      internalAnalysisSetting: z.enum(["Append", "Overwrite", "Ignore"]).optional().describe("How to merge the internal analysis note"),
      resolutionSetting:       z.enum(["Append", "Overwrite", "Ignore"]).optional().describe("How to merge the resolution note"),
      tasksSetting:            z.enum(["Append", "Overwrite", "Ignore"]).optional().describe("How to merge the template's tasks onto the ticket"),
    },
    async ({ boardId, typeId, subTypeId, itemId, templateId, summarySetting, discussionSetting, internalAnalysisSetting, resolutionSetting, tasksSetting }) => {
      const body = {
        board:           { id: boardId },
        type:            { id: typeId },
        subtype:         { id: subTypeId },
        item:            { id: itemId },
        serviceTemplate: { id: templateId },
        ...(summarySetting          && { summarySetting }),
        ...(discussionSetting       && { discussionSetting }),
        ...(internalAnalysisSetting && { internalAnalysisSetting }),
        ...(resolutionSetting       && { resolutionSetting }),
        ...(tasksSetting            && { tasksSetting }),
      };
      const data = await cwRequest("POST", `/service/boards/${boardId}/autoTemplates`, {}, body);
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
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/project/projects", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
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

  server.tool(
    "get_project_phases",
    "Get all phases for a ConnectWise project",
    {
      projectId:  z.number().describe("The project ID"),
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ projectId, conditions, pageSize, page }) => {
      const data = await cwRequest("GET", `/project/projects/${projectId}/phases`, {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_project_notes",
    "Get all notes for a ConnectWise project",
    {
      projectId:  z.number().describe("The project ID"),
      conditions: z.string().optional().describe("CW condition string"),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
    },
    async ({ projectId, conditions, pageSize, page }) => {
      const data = await cwRequest("GET", `/project/projects/${projectId}/notes`, {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "add_project_note",
    "Add a note to a ConnectWise project",
    {
      projectId: z.number().describe("The project ID"),
      text:      z.string().describe("Note text content"),
      flagged:   z.boolean().optional().describe("Flag the note"),
    },
    async ({ projectId, text, flagged }) => {
      const body = { text, ...(flagged !== undefined && { flagged }) };
      const data = await cwRequest("POST", `/project/projects/${projectId}/notes`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_project_tickets",
    "Search and list ConnectWise project tickets",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "project/id=123"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/project/tickets", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  OPPORTUNITIES (SALES)
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_opportunities",
    "Search and list ConnectWise sales opportunities",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "company/id=123 AND status/name=\'Open\'"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/sales/opportunities", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_opportunity",
    "Get a single ConnectWise sales opportunity by ID",
    { opportunityId: z.number().describe("The opportunity ID") },
    async ({ opportunityId }) => {
      const data = await cwRequest("GET", `/sales/opportunities/${opportunityId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_opportunity",
    "Create a new ConnectWise sales opportunity",
    {
      name:                z.string().describe("Opportunity name (max 100 chars)"),
      companyId:           z.number().describe("Company ID"),
      contactId:           z.number().describe("Primary contact ID"),
      primarySalesRepId:   z.number().describe("Primary sales rep member ID"),
      typeId:              z.number().optional().describe("Opportunity type ID"),
      stageId:             z.number().optional().describe("Stage ID"),
      statusId:            z.number().optional().describe("Status ID"),
      priorityId:          z.number().optional().describe("Priority ID"),
      probabilityId:       z.number().optional().describe("Probability ID"),
      ratingId:            z.number().optional().describe("Rating ID"),
      expectedCloseDate:   z.string().optional().describe("Expected close date (ISO 8601)"),
      source:              z.string().optional().describe("Lead source (max 50 chars)"),
      notes:               z.string().optional().describe("Notes"),
      customerPO:          z.string().optional().describe("Customer PO (max 25 chars)"),
      secondarySalesRepId: z.number().optional().describe("Secondary sales rep member ID"),
    },
    async ({
      name, companyId, contactId, primarySalesRepId, typeId, stageId, statusId,
      priorityId, probabilityId, ratingId, expectedCloseDate, source, notes,
      customerPO, secondarySalesRepId,
    }) => {
      const body = {
        name,
        company: { id: companyId },
        contact: { id: contactId },
        primarySalesRep: { id: primarySalesRepId },
        ...(typeId              && { type:              { id: typeId } }),
        ...(stageId             && { stage:             { id: stageId } }),
        ...(statusId            && { status:            { id: statusId } }),
        ...(priorityId          && { priority:          { id: priorityId } }),
        ...(probabilityId       && { probability:       { id: probabilityId } }),
        ...(ratingId            && { rating:            { id: ratingId } }),
        ...(secondarySalesRepId && { secondarySalesRep: { id: secondarySalesRepId } }),
        ...(expectedCloseDate   && { expectedCloseDate }),
        ...(source              && { source }),
        ...(notes               && { notes }),
        ...(customerPO          && { customerPO }),
      };
      const data = await cwRequest("POST", "/sales/opportunities", {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_opportunity",
    "Update a ConnectWise sales opportunity",
    {
      opportunityId:     z.number().describe("Opportunity ID to update"),
      name:              z.string().optional().describe("New name"),
      stageId:           z.number().optional().describe("New stage ID"),
      statusId:          z.number().optional().describe("New status ID"),
      probabilityId:     z.number().optional().describe("New probability ID"),
      expectedCloseDate: z.string().optional().describe("New expected close date (ISO 8601)"),
      notes:             z.string().optional().describe("New notes"),
    },
    async ({ opportunityId, name, stageId, statusId, probabilityId, expectedCloseDate, notes }) => {
      const ops = [];
      if (name !== undefined)              ops.push({ op: "replace", path: "/name",              value: name });
      if (stageId !== undefined)           ops.push({ op: "replace", path: "/stage/id",          value: stageId });
      if (statusId !== undefined)          ops.push({ op: "replace", path: "/status/id",         value: statusId });
      if (probabilityId !== undefined)     ops.push({ op: "replace", path: "/probability/id",    value: probabilityId });
      if (expectedCloseDate !== undefined) ops.push({ op: "replace", path: "/expectedCloseDate", value: expectedCloseDate });
      if (notes !== undefined)             ops.push({ op: "replace", path: "/notes",             value: notes });
      const data = await cwRequest("PATCH", `/sales/opportunities/${opportunityId}`, {}, ops);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_opportunity_notes",
    "Get all notes for a ConnectWise opportunity",
    {
      opportunityId: z.number().describe("The opportunity ID"),
      pageSize:      z.number().optional().describe("Number of results (default 25)"),
      page:          z.number().optional().describe("Page number"),
    },
    async ({ opportunityId, pageSize, page }) => {
      const data = await cwRequest("GET", `/sales/opportunities/${opportunityId}/notes`, {
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "add_opportunity_note",
    "Add a note to a ConnectWise opportunity",
    {
      opportunityId: z.number().describe("The opportunity ID"),
      text:          z.string().describe("Note text content"),
      flagged:       z.boolean().optional().describe("Flag the note"),
    },
    async ({ opportunityId, text, flagged }) => {
      const body = { text, ...(flagged !== undefined && { flagged }) };
      const data = await cwRequest("POST", `/sales/opportunities/${opportunityId}/notes`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_opportunity_statuses",
    "Get all ConnectWise opportunity statuses",
    {},
    async () => {
      const data = await cwRequest("GET", "/sales/opportunities/statuses", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_opportunity_stages",
    "Get all ConnectWise opportunity sales stages",
    {},
    async () => {
      const data = await cwRequest("GET", "/sales/stages", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_opportunity_types",
    "Get all ConnectWise opportunity types",
    {},
    async () => {
      const data = await cwRequest("GET", "/sales/opportunities/types", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  PRODUCTS / CATALOG (PROCUREMENT)
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "get_products",
    "Search and list ConnectWise product items (placed on tickets, projects, opportunities, sales orders)",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "ticket/id=1234" or "opportunity/id=567"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/procurement/products", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_product",
    "Get a single ConnectWise product item by ID",
    { productId: z.number().describe("The product item ID") },
    async ({ productId }) => {
      const data = await cwRequest("GET", `/procurement/products/${productId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_catalog_items",
    "Search and list ConnectWise product catalog items (the master product list)",
    {
      conditions: z.string().optional().describe('CW condition string e.g. "identifier like \'SKU%\' AND inactiveFlag=false"'),
      pageSize:   z.number().optional().describe("Number of results (default 25)"),
      page:       z.number().optional().describe("Page number"),
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/procurement/catalog", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_catalog_item",
    "Get a single ConnectWise catalog item by ID",
    { catalogItemId: z.number().describe("The catalog item ID") },
    async ({ catalogItemId }) => {
      const data = await cwRequest("GET", `/procurement/catalog/${catalogItemId}`);
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
      orderBy:    z.string().optional().describe("Sort order"),
    },
    async ({ conditions, pageSize, page, orderBy }) => {
      const data = await cwRequest("GET", "/finance/agreements", {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_agreement",
    "Get a single ConnectWise agreement by ID",
    { agreementId: z.number().describe("The agreement ID") },
    async ({ agreementId }) => {
      const data = await cwRequest("GET", `/finance/agreements/${agreementId}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_agreement_additions",
    "Get additions (line items) for a ConnectWise agreement",
    {
      agreementId: z.number().describe("The agreement ID"),
      conditions:  z.string().optional().describe("CW condition string"),
      pageSize:    z.number().optional().describe("Number of results (default 25)"),
      page:        z.number().optional().describe("Page number"),
    },
    async ({ agreementId, conditions, pageSize, page }) => {
      const data = await cwRequest("GET", `/finance/agreements/${agreementId}/additions`, {
        conditions,
        pageSize: pageSize || 25,
        page:     page || 1,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_agreement_types",
    "Get all ConnectWise agreement types",
    {},
    async () => {
      const data = await cwRequest("GET", "/finance/agreements/types", { pageSize: 100 });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_agreement",
    "Create a new ConnectWise agreement on a company. Use add_agreement_addition afterwards to attach product line items.",
    {
      name:             z.string().describe("Agreement name (max 100 chars)"),
      typeId:           z.number().describe("Agreement type ID (use get_agreement_types to find)"),
      companyId:        z.number().describe("Company ID"),
      contactId:        z.number().describe("Primary contact ID"),
      startDate:        z.string().optional().describe("Start date (ISO 8601)"),
      endDate:          z.string().optional().describe("End date (ISO 8601)"),
      noEndingDateFlag: z.boolean().optional().describe("True if agreement has no end date"),
      billAmount:       z.number().optional().describe("Bill amount"),
      billOneTimeFlag:  z.boolean().optional().describe("True for one-time billing"),
      billingCycleId:   z.number().optional().describe("Billing cycle ID"),
      billingTermsId:   z.number().optional().describe("Billing terms ID"),
      customerPO:       z.string().optional().describe("Customer PO (max 50 chars)"),
      workOrder:        z.string().optional().describe("Work order (max 20 chars)"),
      internalNotes:    z.string().optional().describe("Internal notes"),
      locationId:       z.number().optional().describe("System location ID"),
      departmentId:     z.number().optional().describe("System department ID"),
      siteId:           z.number().optional().describe("Site ID"),
      parentAgreementId:z.number().optional().describe("Parent agreement ID for sub-agreements"),
      opportunityId:    z.number().optional().describe("Source opportunity ID"),
      applicationUnits: z.enum(["Amount", "Hours", "Incidents"]).optional().describe("Application units"),
      applicationLimit: z.number().optional().describe("Application limit"),
      applicationCycle: z.enum(["Contract2Weeks","Contract4Weeks","ContractYear","CalendarMonth","CalendarQuarter","CalendarWeek","ContractQuarter","CalendarYear"]).optional().describe("Application cycle"),
      applicationUnlimitedFlag: z.boolean().optional().describe("Unlimited application"),
      oneTimeFlag:      z.boolean().optional().describe("One-time agreement"),
    },
    async ({
      name, typeId, companyId, contactId, startDate, endDate, noEndingDateFlag,
      billAmount, billOneTimeFlag, billingCycleId, billingTermsId, customerPO,
      workOrder, internalNotes, locationId, departmentId, siteId, parentAgreementId,
      opportunityId, applicationUnits, applicationLimit, applicationCycle,
      applicationUnlimitedFlag, oneTimeFlag,
    }) => {
      const body = {
        name,
        type:    { id: typeId },
        company: { id: companyId },
        contact: { id: contactId },
        ...(startDate          && { startDate }),
        ...(endDate            && { endDate }),
        ...(noEndingDateFlag !== undefined && { noEndingDateFlag }),
        ...(billAmount !== undefined       && { billAmount }),
        ...(billOneTimeFlag !== undefined  && { billOneTimeFlag }),
        ...(billingCycleId     && { billingCycle: { id: billingCycleId } }),
        ...(billingTermsId     && { billingTerms: { id: billingTermsId } }),
        ...(customerPO         && { customerPO }),
        ...(workOrder          && { workOrder }),
        ...(internalNotes      && { internalNotes }),
        ...(locationId         && { location:   { id: locationId } }),
        ...(departmentId       && { department: { id: departmentId } }),
        ...(siteId             && { site:       { id: siteId } }),
        ...(parentAgreementId  && { parentAgreement: { id: parentAgreementId } }),
        ...(opportunityId      && { opportunity:     { id: opportunityId } }),
        ...(applicationUnits   && { applicationUnits }),
        ...(applicationLimit !== undefined && { applicationLimit }),
        ...(applicationCycle   && { applicationCycle }),
        ...(applicationUnlimitedFlag !== undefined && { applicationUnlimitedFlag }),
        ...(oneTimeFlag !== undefined      && { oneTimeFlag }),
      };
      const data = await cwRequest("POST", "/finance/agreements", {}, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "add_agreement_addition",
    "Add a product addition (line item) to a ConnectWise agreement",
    {
      agreementId:        z.number().describe("Parent agreement ID"),
      catalogItemId:      z.number().describe("Catalog item / product ID (use get_catalog_items to find)"),
      billCustomer:       z.enum(["Billable", "DoNotBill", "NoCharge"]).describe("Billing option"),
      quantity:           z.number().optional().describe("Quantity"),
      lessIncluded:       z.number().optional().describe("Quantity included with agreement (not billed)"),
      unitPrice:          z.number().optional().describe("Unit price"),
      unitCost:           z.number().optional().describe("Unit cost"),
      effectiveDate:      z.string().optional().describe("Effective date (ISO 8601)"),
      cancelledDate:      z.string().optional().describe("Cancelled date (ISO 8601)"),
      taxableFlag:        z.boolean().optional().describe("Taxable"),
      serialNumber:       z.string().optional().describe("Serial number (max 50 chars)"),
      invoiceDescription: z.string().optional().describe("Invoice description (max 6000 chars)"),
      description:        z.string().optional().describe("Description"),
      agreementStatus:    z.enum(["Active", "Cancelled", "Expired", "Inactive"]).optional().describe("Addition status"),
      sequenceNumber:     z.number().optional().describe("Display sequence number"),
    },
    async ({
      agreementId, catalogItemId, billCustomer, quantity, lessIncluded, unitPrice,
      unitCost, effectiveDate, cancelledDate, taxableFlag, serialNumber,
      invoiceDescription, description, agreementStatus, sequenceNumber,
    }) => {
      const body = {
        product: { id: catalogItemId },
        billCustomer,
        ...(quantity !== undefined     && { quantity }),
        ...(lessIncluded !== undefined && { lessIncluded }),
        ...(unitPrice !== undefined    && { unitPrice }),
        ...(unitCost !== undefined     && { unitCost }),
        ...(effectiveDate              && { effectiveDate }),
        ...(cancelledDate              && { cancelledDate }),
        ...(taxableFlag !== undefined  && { taxableFlag }),
        ...(serialNumber               && { serialNumber }),
        ...(invoiceDescription         && { invoiceDescription }),
        ...(description                && { description }),
        ...(agreementStatus            && { agreementStatus }),
        ...(sequenceNumber !== undefined && { sequenceNumber }),
      };
      const data = await cwRequest("POST", `/finance/agreements/${agreementId}/additions`, {}, body);
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
