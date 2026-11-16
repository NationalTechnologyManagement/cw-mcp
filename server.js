import "./vault.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import axios from "axios";
import { createServer } from "http";
import { createHash, timingSafeEqual } from "crypto";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

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
const CW_TIMEOUT_MS = Number(process.env.CW_TIMEOUT_MS) || 30_000;

async function cwRequest(method, path, params = {}, data = null) {
  const url = `${CW_BASE_URL}/${API_VERSION}/apis/3.0${path}`;
  try {
    const res = await axios({
      method,
      url,
      headers: getAuthHeaders(),
      params: method === "GET" ? params : undefined,
      data: method !== "GET" ? data : undefined,
      timeout: CW_TIMEOUT_MS,
    });
    return res.data;
  } catch (err) {
    throw new Error(formatCwError(err));
  }
}

// CW error bodies look like { code, message, errors: [{ code, message, resource, field }] }.
// Surface the per-field details so a failed write says *which* field CW rejected.
function formatCwError(err) {
  if (err.code === "ECONNABORTED") {
    return `CW API Error [timeout]: no response within ${CW_TIMEOUT_MS}ms`;
  }
  const status = err.response?.status ?? "network";
  const body   = err.response?.data;
  let msg = (body && typeof body === "object" ? body.message : body) || err.message;
  const details = Array.isArray(body?.errors)
    ? body.errors
        .map((e) => [e.field || e.resource, e.message].filter(Boolean).join(": "))
        .filter(Boolean)
    : [];
  if (details.length) msg += ` — ${details.join("; ")}`;
  return `CW API Error [${status}]: ${msg}`;
}

// ─── Tool helpers ────────────────────────────────────────────────────────────
const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

// Drop undefined keys so CW only sees fields the caller actually set.
const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

// { id } reference, or undefined when no id was given (removed by clean()).
const ref = (id) => (id === undefined || id === null ? undefined : { id });

// JSON Patch "replace" ops for every path whose value is defined.
const patchOps = (fields) => {
  const ops = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([path, value]) => ({ op: "replace", path, value }));
  if (!ops.length) throw new Error("Nothing to update: pass at least one field to change");
  return ops;
};

// Ticket note body. "discussion" maps to detailDescriptionFlag (CW has no discussionFlag).
const noteBody = (text, noteType = "discussion") => ({
  text,
  ...(noteType === "discussion" && { detailDescriptionFlag: true }),
  ...(noteType === "internal"   && { internalAnalysisFlag: true }),
  ...(noteType === "resolution" && { resolutionFlag: true }),
});

const BILLING_METHODS = ["ActualRates", "FixedFee", "NotToExceed", "OverrideRate"];
const BILL_OPTIONS    = ["Billable", "DoNotBill", "NoCharge", "NoDefault"];

// Optional fields shared by create_project and create_project_from_template.
const projectOptionalFields = {
  statusId:     z.number().optional().describe("Project status ID (use get_project_statuses)"),
  typeId:       z.number().optional().describe("Project type ID (use get_project_types)"),
  managerId:    z.number().optional().describe("Project manager member ID"),
  contactId:    z.number().optional().describe("Primary contact ID"),
  agreementId:  z.number().optional().describe("Agreement ID"),
  opportunityId:z.number().optional().describe("Source opportunity ID"),
  locationId:   z.number().optional().describe("System location ID"),
  departmentId: z.number().optional().describe("System department ID"),
  description:  z.string().optional().describe("Project description"),
  budgetHours:  z.number().optional().describe("Budget hours"),
  billingAmount:z.number().optional().describe("Billing amount (fixed fee / not-to-exceed)"),
  customerPO:   z.string().optional().describe("Customer PO"),
  billTime:     z.enum(BILL_OPTIONS).optional().describe("Billing option for time"),
  billExpenses: z.enum(BILL_OPTIONS).optional().describe("Billing option for expenses"),
  billProducts: z.enum(BILL_OPTIONS).optional().describe("Billing option for products"),
};

function projectBody(a) {
  return clean({
    name:           a.name,
    company:        { id: a.companyId },
    board:          { id: a.boardId },
    billingMethod:  a.billingMethod,
    estimatedStart: a.estimatedStart,
    estimatedEnd:   a.estimatedEnd,
    status:         ref(a.statusId),
    type:           ref(a.typeId),
    manager:        ref(a.managerId),
    contact:        ref(a.contactId),
    agreement:      ref(a.agreementId),
    opportunity:    ref(a.opportunityId),
    location:       ref(a.locationId),
    department:     ref(a.departmentId),
    description:    a.description,
    budgetHours:    a.budgetHours,
    billingAmount:  a.billingAmount,
    customerPO:     a.customerPO,
    billTime:       a.billTime,
    billExpenses:   a.billExpenses,
    billProducts:   a.billProducts,
  });
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────
// A new McpServer instance must be created per HTTP request — the MCP SDK does
// not allow a single instance to connect to multiple transports.
function createMcpServer() {
  const server = new McpServer({
    name: "connectwise-mcp",
    version: "1.2.0",
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
    "update_service_template",
    "Edit an existing ConnectWise service ticket template — e.g. change its Type/SubType/Item, default status, summary, or name. Only the fields you pass are changed.",
    {
      templateId:   z.number().describe("The service template ID to update (e.g. 220)"),
      name:         z.string().optional().describe("New template name"),
      summary:      z.string().optional().describe("New default summary"),
      statusId:     z.number().optional().describe("New default status ID"),
      typeId:       z.number().optional().describe("New ticket type ID (e.g. 283 = Billable Work)"),
      subTypeId:    z.number().optional().describe("New ticket subtype ID (e.g. 249 = New User Setup)"),
      itemId:       z.number().optional().describe("New ticket item ID (e.g. 15 = New User)"),
      priorityId:   z.number().optional().describe("New priority ID"),
      problem:      z.string().optional().describe("New initial/problem description"),
      boardId:      z.number().optional().describe("Move the template to a different board (may be restricted by CW)"),
      templateFlag: z.boolean().optional().describe("Toggle the reusable-template flag"),
    },
    async ({ templateId, name, summary, statusId, typeId, subTypeId, itemId, priorityId, problem, boardId, templateFlag }) => {
      const ops = [];
      if (name !== undefined)         ops.push({ op: "replace", path: "/name",         value: name });
      if (summary !== undefined)      ops.push({ op: "replace", path: "/summary",      value: summary });
      if (statusId !== undefined)     ops.push({ op: "replace", path: "/status/id",    value: statusId });
      if (typeId !== undefined)       ops.push({ op: "replace", path: "/type/id",      value: typeId });
      if (subTypeId !== undefined)    ops.push({ op: "replace", path: "/subtype/id",   value: subTypeId });
      if (itemId !== undefined)       ops.push({ op: "replace", path: "/item/id",      value: itemId });
      if (priorityId !== undefined)   ops.push({ op: "replace", path: "/priority/id",  value: priorityId });
      if (problem !== undefined)      ops.push({ op: "replace", path: "/problem",      value: problem });
      if (boardId !== undefined)      ops.push({ op: "replace", path: "/board/id",     value: boardId });
      if (templateFlag !== undefined) ops.push({ op: "replace", path: "/templateFlag", value: templateFlag });
      const data = await cwRequest("PATCH", `/service/templates/${templateId}`, {}, ops);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_service_template",
    "Delete a ConnectWise service ticket template by ID (removes the template and its task templates). Destructive and not reversible.",
    { templateId: z.number().describe("The service template ID to delete") },
    async ({ templateId }) => {
      const data = await cwRequest("DELETE", `/service/templates/${templateId}`);
      return { content: [{ type: "text", text: JSON.stringify(data || { deleted: true, templateId }, null, 2) }] };
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
    "update_service_template_task",
    "Edit an existing task template (checklist item) on a service ticket template. Only the fields you pass are changed.",
    {
      templateId: z.number().describe("The parent service template ID"),
      taskId:     z.number().describe("The task template ID to update"),
      priority:   z.number().optional().describe("New order/sequence number"),
      notes:      z.string().optional().describe("New task text/description"),
      codeId:     z.number().optional().describe("New service code ID"),
    },
    async ({ templateId, taskId, priority, notes, codeId }) => {
      const ops = [];
      if (priority !== undefined) ops.push({ op: "replace", path: "/priority", value: priority });
      if (notes !== undefined)    ops.push({ op: "replace", path: "/notes",    value: notes });
      if (codeId !== undefined)   ops.push({ op: "replace", path: "/code/id",  value: codeId });
      const data = await cwRequest("PATCH", `/service/templates/${templateId}/tasks/${taskId}`, {}, ops);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "delete_service_template_task",
    "Delete a task template (checklist item) from a service ticket template. Destructive and not reversible.",
    {
      templateId: z.number().describe("The parent service template ID"),
      taskId:     z.number().describe("The task template ID to delete"),
    },
    async ({ templateId, taskId }) => {
      const data = await cwRequest("DELETE", `/service/templates/${templateId}/tasks/${taskId}`);
      return { content: [{ type: "text", text: JSON.stringify(data || { deleted: true, taskId }, null, 2) }] };
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
      workTypeId:   z.number().optional().describe("Work type ID (use get_work_types)"),
      billableOption: z.enum(["Billable", "DoNotBill", "NoCharge", "NoDefault"]).optional().describe("Billing option for this entry (defaults to the work type's setting)"),
      internalNotes:  z.string().optional().describe("Internal notes (not visible to the customer)"),
    },
    async ({ chargeToId, chargeToType, timeStart, timeEnd, notes, memberId, workTypeId, billableOption, internalNotes }) => {
      const body = {
        chargeToId,
        chargeToType,
        timeStart,
        timeEnd,
        ...(notes      && { notes }),
        ...(memberId   && { member:   { id: memberId } }),
        ...(workTypeId && { workType: { id: workTypeId } }),
        ...(billableOption && { billableOption }),
        ...(internalNotes  && { internalNotes }),
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

  // ══════════════════════════════════════════════════════════════════════════════
  //  PROJECTS — create/update and lookups
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_project",
    "Create a ConnectWise project. Look up IDs first with get_project_boards, get_project_statuses and get_project_types. To build the work plan from a template, use create_project_from_template instead.",
    {
      name:           z.string().describe("Project name (max 100 chars)"),
      companyId:      z.number().describe("Company ID"),
      boardId:        z.number().describe("Project board ID (use get_project_boards)"),
      billingMethod:  z.enum(BILLING_METHODS).describe("Billing method"),
      estimatedStart: z.string().describe("Estimated start (ISO 8601, e.g. 2026-12-01T00:00:00Z)"),
      estimatedEnd:   z.string().describe("Estimated end (ISO 8601)"),
      ...projectOptionalFields,
    },
    async (args) => {
      const data = await cwRequest("POST", "/project/projects", {}, projectBody(args));
      return json(data);
    }
  );

  server.tool(
    "update_project",
    "Update a ConnectWise project. Only the fields you pass are changed.",
    {
      projectId:       z.number().describe("Project ID to update"),
      name:            z.string().optional().describe("New name"),
      statusId:        z.number().optional().describe("New project status ID (use get_project_statuses)"),
      typeId:          z.number().optional().describe("New project type ID (use get_project_types)"),
      boardId:         z.number().optional().describe("New project board ID"),
      managerId:       z.number().optional().describe("New project manager member ID"),
      contactId:       z.number().optional().describe("New primary contact ID"),
      estimatedStart:  z.string().optional().describe("New estimated start (ISO 8601)"),
      estimatedEnd:    z.string().optional().describe("New estimated end (ISO 8601)"),
      billingMethod:   z.enum(BILLING_METHODS).optional().describe("New billing method"),
      budgetHours:     z.number().optional().describe("New budget hours"),
      description:     z.string().optional().describe("New description"),
      customerPO:      z.string().optional().describe("New customer PO"),
      percentComplete: z.number().optional().describe("Override percent complete (0-100)"),
      closedFlag:      z.boolean().optional().describe("Close (true) or reopen (false) the project"),
    },
    async ({ projectId, ...f }) => {
      const ops = patchOps({
        "/name": f.name, "/status/id": f.statusId, "/type/id": f.typeId, "/board/id": f.boardId,
        "/manager/id": f.managerId, "/contact/id": f.contactId, "/estimatedStart": f.estimatedStart,
        "/estimatedEnd": f.estimatedEnd, "/billingMethod": f.billingMethod, "/budgetHours": f.budgetHours,
        "/description": f.description, "/customerPO": f.customerPO,
        "/percentComplete": f.percentComplete, "/closedFlag": f.closedFlag,
      });
      return json(await cwRequest("PATCH", `/project/projects/${projectId}`, {}, ops));
    }
  );

  listTool("get_project_statuses", "List ConnectWise project statuses (for create_project / update_project)", () => "/project/statuses");
  listTool("get_project_types", "List ConnectWise project types", () => "/project/projectTypes");

  server.tool(
    "get_project_boards",
    "List ConnectWise project boards (boards with the project flag set). Use the board ID for create_project, phases and project tickets.",
    {},
    async () => json(await cwRequest("GET", "/service/boards", { conditions: "projectFlag=true", pageSize: 100 }))
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  PROJECT WORK PLAN — phases, project tickets, notes, tasks
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "create_project_phase",
    "Add a phase to a ConnectWise project's work plan. Pass parentPhaseId to nest it under another phase.",
    {
      projectId:          z.number().describe("Project ID"),
      description:        z.string().describe("Phase name/description"),
      parentPhaseId:      z.number().optional().describe("Parent phase ID, to create a sub-phase"),
      statusId:           z.number().optional().describe("Phase status ID"),
      boardId:            z.number().optional().describe("Project board ID"),
      budgetHours:        z.number().optional().describe("Budget hours"),
      scheduledStart:     z.string().optional().describe("Scheduled start (ISO 8601)"),
      scheduledEnd:       z.string().optional().describe("Scheduled end (ISO 8601)"),
      deadlineDate:       z.string().optional().describe("Deadline (ISO 8601)"),
      notes:              z.string().optional().describe("Phase notes"),
      wbsCode:            z.string().optional().describe("WBS code"),
      markAsMilestoneFlag:z.boolean().optional().describe("Mark as a milestone"),
      billSeparatelyFlag: z.boolean().optional().describe("Bill this phase separately"),
      billingMethod:      z.enum(BILLING_METHODS).optional().describe("Billing method (only when billed separately)"),
    },
    async ({ projectId, parentPhaseId, statusId, boardId, ...rest }) => {
      const body = clean({
        ...rest,
        parentPhase: ref(parentPhaseId),
        status:      ref(statusId),
        board:       ref(boardId),
      });
      return json(await cwRequest("POST", `/project/projects/${projectId}/phases`, {}, body));
    }
  );

  server.tool(
    "update_project_phase",
    "Update a phase on a ConnectWise project. Only the fields you pass are changed.",
    {
      projectId:          z.number().describe("Project ID"),
      phaseId:            z.number().describe("Phase ID to update"),
      description:        z.string().optional().describe("New phase name/description"),
      statusId:           z.number().optional().describe("New phase status ID"),
      parentPhaseId:      z.number().optional().describe("Move under this parent phase"),
      budgetHours:        z.number().optional().describe("New budget hours"),
      scheduledStart:     z.string().optional().describe("New scheduled start (ISO 8601)"),
      scheduledEnd:       z.string().optional().describe("New scheduled end (ISO 8601)"),
      deadlineDate:       z.string().optional().describe("New deadline (ISO 8601)"),
      notes:              z.string().optional().describe("New notes"),
      wbsCode:            z.string().optional().describe("New WBS code"),
      markAsMilestoneFlag:z.boolean().optional().describe("Milestone flag"),
    },
    async ({ projectId, phaseId, ...f }) => {
      const ops = patchOps({
        "/description": f.description, "/status/id": f.statusId, "/parentPhase/id": f.parentPhaseId,
        "/budgetHours": f.budgetHours, "/scheduledStart": f.scheduledStart, "/scheduledEnd": f.scheduledEnd,
        "/deadlineDate": f.deadlineDate, "/notes": f.notes, "/wbsCode": f.wbsCode,
        "/markAsMilestoneFlag": f.markAsMilestoneFlag,
      });
      return json(await cwRequest("PATCH", `/project/projects/${projectId}/phases/${phaseId}`, {}, ops));
    }
  );

  server.tool(
    "get_project_ticket",
    "Get a single ConnectWise project ticket by ID",
    { ticketId: z.number().describe("The project ticket ID") },
    async ({ ticketId }) => json(await cwRequest("GET", `/project/tickets/${ticketId}`))
  );

  server.tool(
    "create_project_ticket",
    "Create a ticket in a ConnectWise project phase (a work plan line item). Use get_project_phases to find the phase ID.",
    {
      summary:            z.string().describe("Ticket summary (max 100 chars)"),
      phaseId:            z.number().describe("Project phase ID the ticket belongs to"),
      projectId:          z.number().optional().describe("Project ID (CW infers it from the phase, but passing it is harmless)"),
      boardId:            z.number().optional().describe("Project board ID"),
      statusId:           z.number().optional().describe("Status ID (statuses of the project board, use get_statuses)"),
      priorityId:         z.number().optional().describe("Priority ID"),
      typeId:             z.number().optional().describe("Type ID"),
      subTypeId:          z.number().optional().describe("Subtype ID"),
      itemId:             z.number().optional().describe("Item ID"),
      workTypeId:         z.number().optional().describe("Default work type ID"),
      workRoleId:         z.number().optional().describe("Default work role ID"),
      contactId:          z.number().optional().describe("Contact ID"),
      ownerId:            z.number().optional().describe("Owner member ID"),
      budgetHours:        z.number().optional().describe("Budget hours"),
      requiredDate:       z.string().optional().describe("Due date (ISO 8601)"),
      wbsCode:            z.string().optional().describe("WBS code"),
      initialDescription: z.string().optional().describe("Initial description / notes"),
      billTime:           z.enum(BILL_OPTIONS).optional().describe("Billing option for time"),
    },
    async ({ phaseId, projectId, boardId, statusId, priorityId, typeId, subTypeId, itemId, workTypeId, workRoleId, contactId, ownerId, ...rest }) => {
      const body = clean({
        ...rest,
        phase:    { id: phaseId },
        project:  ref(projectId),
        board:    ref(boardId),
        status:   ref(statusId),
        priority: ref(priorityId),
        type:     ref(typeId),
        subType:  ref(subTypeId),
        item:     ref(itemId),
        workType: ref(workTypeId),
        workRole: ref(workRoleId),
        contact:  ref(contactId),
        owner:    ref(ownerId),
      });
      return json(await cwRequest("POST", "/project/tickets", {}, body));
    }
  );

  server.tool(
    "update_project_ticket",
    "Update a ConnectWise project ticket. Only the fields you pass are changed.",
    {
      ticketId:     z.number().describe("Project ticket ID to update"),
      summary:      z.string().optional().describe("New summary"),
      statusId:     z.number().optional().describe("New status ID"),
      phaseId:      z.number().optional().describe("Move to this phase ID"),
      priorityId:   z.number().optional().describe("New priority ID"),
      ownerId:      z.number().optional().describe("New owner member ID"),
      budgetHours:  z.number().optional().describe("New budget hours"),
      requiredDate: z.string().optional().describe("New due date (ISO 8601)"),
      workTypeId:   z.number().optional().describe("New work type ID"),
      workRoleId:   z.number().optional().describe("New work role ID"),
      wbsCode:      z.string().optional().describe("New WBS code"),
      closedFlag:   z.boolean().optional().describe("Close (true) or reopen (false)"),
    },
    async ({ ticketId, ...f }) => {
      const ops = patchOps({
        "/summary": f.summary, "/status/id": f.statusId, "/phase/id": f.phaseId,
        "/priority/id": f.priorityId, "/owner/id": f.ownerId, "/budgetHours": f.budgetHours,
        "/requiredDate": f.requiredDate, "/workType/id": f.workTypeId, "/workRole/id": f.workRoleId,
        "/wbsCode": f.wbsCode, "/closedFlag": f.closedFlag,
      });
      return json(await cwRequest("PATCH", `/project/tickets/${ticketId}`, {}, ops));
    }
  );

  listTool("get_project_ticket_notes", "Get notes on a ConnectWise project ticket",
    ({ ticketId }) => `/project/tickets/${ticketId}/notes`, { ticketId: z.number().describe("Project ticket ID") });

  server.tool(
    "add_project_ticket_note",
    "Add a note to a ConnectWise project ticket",
    {
      ticketId: z.number().describe("Project ticket ID"),
      text:     z.string().describe("Note text"),
      noteType: z.enum(["discussion", "internal", "resolution"]).optional().describe("Tab to post to: discussion (default), internal (Internal Analysis), resolution"),
    },
    async ({ ticketId, text, noteType }) => json(await cwRequest("POST", `/project/tickets/${ticketId}/notes`, {}, noteBody(text, noteType)))
  );

  ticketTaskTools("project_ticket", "/project/tickets", "project ticket");

  // ══════════════════════════════════════════════════════════════════════════════
  //  PROJECT TEMPLATES
  // ══════════════════════════════════════════════════════════════════════════════

  listTool("get_project_templates", "Search and list ConnectWise project templates", () => "/project/projectTemplates/");

  server.tool(
    "get_project_template_workplan",
    "Get the full work plan (phases and tickets) of a ConnectWise project template",
    { templateId: z.number().describe("Project template ID") },
    async ({ templateId }) => json(await cwRequest("GET", `/project/projectTemplates/${templateId}/workplan`))
  );

  server.tool(
    "create_project_template",
    "Create an empty ConnectWise project template. Then add phases with create_project_template_phase and tickets with create_project_template_ticket. To copy an existing project's work plan, use create_project_template_from_project.",
    {
      name:        z.string().describe("Template name"),
      description: z.string().optional().describe("Template description"),
      typeId:      z.number().optional().describe("Project type ID (use get_project_types)"),
    },
    async ({ name, description, typeId }) =>
      json(await cwRequest("POST", "/project/projectTemplates/", {}, clean({ name, description, type: ref(typeId) })))
  );

  server.tool(
    "create_project_template_from_project",
    "Create a ConnectWise project template from an existing project's work plan",
    {
      projectId:   z.number().describe("Source project ID"),
      name:        z.string().describe("New template name"),
      description: z.string().optional().describe("Template description"),
      typeId:      z.number().optional().describe("Project type ID"),
    },
    async ({ projectId, name, description, typeId }) =>
      json(await cwRequest("POST", `/project/projectTemplates/createFromProject/${projectId}`, {}, clean({ name, description, type: ref(typeId) })))
  );

  listTool("get_project_template_phases", "List the phases of a ConnectWise project template",
    ({ templateId }) => `/project/projectTemplates/${templateId}/projectTemplatePhases`,
    { templateId: z.number().describe("Project template ID") });

  server.tool(
    "create_project_template_phase",
    "Add a phase to a ConnectWise project template",
    {
      templateId:            z.number().describe("Project template ID"),
      description:           z.string().describe("Phase name/description"),
      parentPhaseId:         z.number().optional().describe("Parent template phase ID, to nest it"),
      budgetHours:           z.number().optional().describe("Budget hours"),
      notes:                 z.string().optional().describe("Phase notes"),
      wbsCode:               z.string().optional().describe("WBS code"),
      markAsMilestone:       z.boolean().optional().describe("Mark as a milestone"),
      phaseBilledSeparately: z.boolean().optional().describe("Bill this phase separately"),
    },
    async ({ templateId, parentPhaseId, ...rest }) =>
      json(await cwRequest("POST", `/project/projectTemplates/${templateId}/projectTemplatePhases`, {}, clean({ ...rest, parentId: parentPhaseId })))
  );

  listTool("get_project_template_tickets", "List the tickets of a ConnectWise project template",
    ({ templateId }) => `/project/projectTemplates/${templateId}/projectTemplateTickets`,
    { templateId: z.number().describe("Project template ID") });

  server.tool(
    "create_project_template_ticket",
    "Add a ticket to a phase of a ConnectWise project template",
    {
      templateId:      z.number().describe("Project template ID"),
      phaseId:         z.number().describe("Template phase ID (use get_project_template_phases)"),
      description:     z.string().describe("Ticket summary/description"),
      notes:           z.string().optional().describe("Ticket notes"),
      budgetHours:     z.number().optional().describe("Budget hours"),
      lineNumber:      z.number().optional().describe("Order within the phase"),
      wbsCode:         z.string().optional().describe("WBS code"),
      priorityId:      z.number().optional().describe("Priority ID"),
      workTypeId:      z.number().optional().describe("Work type ID"),
      workRoleId:      z.number().optional().describe("Work role ID"),
      markAsMilestoneFlag: z.boolean().optional().describe("Mark as a milestone"),
    },
    async ({ templateId, phaseId, priorityId, workTypeId, workRoleId, ...rest }) => {
      const body = clean({
        ...rest,
        projectTemplatePhaseId: phaseId,
        priority: ref(priorityId),
        workType: ref(workTypeId),
        workRole: ref(workRoleId),
      });
      return json(await cwRequest("POST", `/project/projectTemplates/${templateId}/projectTemplateTickets`, {}, body));
    }
  );

  server.tool(
    "apply_project_template",
    "Apply a project template's phases and tickets to an existing ConnectWise project",
    {
      projectId:  z.number().describe("Project ID"),
      templateId: z.number().describe("Project template ID (use get_project_templates)"),
    },
    async ({ projectId, templateId }) =>
      json((await cwRequest("POST", `/project/projects/${projectId}/applyTemplate/${templateId}`)) || { applied: true, projectId, templateId })
  );

  server.tool(
    "create_project_from_template",
    "Create a ConnectWise project and build its work plan from a project template in one step (creates the project, then applies the template). Returns the project and its phases.",
    {
      templateId:     z.number().describe("Project template ID (use get_project_templates)"),
      name:           z.string().describe("Project name (max 100 chars)"),
      companyId:      z.number().describe("Company ID"),
      boardId:        z.number().describe("Project board ID (use get_project_boards)"),
      billingMethod:  z.enum(BILLING_METHODS).describe("Billing method"),
      estimatedStart: z.string().describe("Estimated start (ISO 8601)"),
      estimatedEnd:   z.string().describe("Estimated end (ISO 8601)"),
      ...projectOptionalFields,
    },
    async ({ templateId, ...args }) => {
      const project = await cwRequest("POST", "/project/projects", {}, projectBody(args));
      try {
        await cwRequest("POST", `/project/projects/${project.id}/applyTemplate/${templateId}`);
      } catch (err) {
        throw new Error(`Project ${project.id} was created, but applying template ${templateId} failed: ${err.message}`);
      }
      const phases = await cwRequest("GET", `/project/projects/${project.id}/phases`, { pageSize: 100 });
      return json({ project, phases });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  TIME ENTRIES — update/delete and lookups
  // ══════════════════════════════════════════════════════════════════════════════

  server.tool(
    "update_time_entry",
    "Update a ConnectWise time entry. Only the fields you pass are changed. Entries on a submitted/approved time sheet may be locked by CW.",
    {
      timeEntryId:    z.number().describe("Time entry ID"),
      timeStart:      z.string().optional().describe("New start (ISO 8601)"),
      timeEnd:        z.string().optional().describe("New end (ISO 8601)"),
      notes:          z.string().optional().describe("New notes"),
      internalNotes:  z.string().optional().describe("New internal notes"),
      workTypeId:     z.number().optional().describe("New work type ID"),
      billableOption: z.enum(BILL_OPTIONS).optional().describe("New billing option"),
      hoursDeduct:    z.number().optional().describe("Hours to deduct (e.g. a break)"),
    },
    async ({ timeEntryId, ...f }) => {
      const ops = patchOps({
        "/timeStart": f.timeStart, "/timeEnd": f.timeEnd, "/notes": f.notes,
        "/internalNotes": f.internalNotes, "/workType/id": f.workTypeId,
        "/billableOption": f.billableOption, "/hoursDeduct": f.hoursDeduct,
      });
      return json(await cwRequest("PATCH", `/time/entries/${timeEntryId}`, {}, ops));
    }
  );

  server.tool(
    "delete_time_entry",
    "Delete a ConnectWise time entry. Destructive and not reversible.",
    { timeEntryId: z.number().describe("Time entry ID to delete") },
    async ({ timeEntryId }) =>
      json((await cwRequest("DELETE", `/time/entries/${timeEntryId}`)) || { deleted: true, timeEntryId })
  );

  listTool("get_work_types", "List ConnectWise work types (for time entries and project tickets)", () => "/time/workTypes");
  listTool("get_charge_codes", "List ConnectWise charge codes (for time not tied to a ticket; use with chargeToType=ChargeCode)", () => "/time/chargeCodes");

  // ══════════════════════════════════════════════════════════════════════════════
  //  TIME SHEETS
  // ══════════════════════════════════════════════════════════════════════════════

  listTool("get_time_sheets", 'List ConnectWise time sheets, e.g. conditions "member/identifier=\'jdoe\' AND status=\'Open\'"', () => "/time/sheets");

  server.tool(
    "submit_time_sheet",
    "Submit a ConnectWise time sheet for approval",
    { timeSheetId: z.number().describe("Time sheet ID (use get_time_sheets)") },
    async ({ timeSheetId }) =>
      json((await cwRequest("POST", `/time/sheets/${timeSheetId}/submit`)) || { submitted: true, timeSheetId })
  );

  server.tool(
    "reverse_time_sheet",
    "Reverse a submitted/approved ConnectWise time sheet back to Open so its entries can be edited",
    { timeSheetId: z.number().describe("Time sheet ID") },
    async ({ timeSheetId }) =>
      json((await cwRequest("POST", `/time/sheets/${timeSheetId}/reverse`)) || { reversed: true, timeSheetId })
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  SCHEDULE
  // ══════════════════════════════════════════════════════════════════════════════

  listTool("get_schedule_entries", 'List ConnectWise schedule entries, e.g. conditions "member/identifier=\'jdoe\' AND dateStart>[2026-12-01T00:00:00Z]"', () => "/schedule/entries");
  listTool("get_schedule_types", "List ConnectWise schedule types (S = service ticket, P = project ticket, C = activity, etc.)", () => "/schedule/types");

  server.tool(
    "create_schedule_entry",
    "Schedule a member on a ConnectWise ticket, project ticket or activity",
    {
      objectId:       z.number().describe("ID of the record being scheduled (service ticket, project ticket or activity ID)"),
      typeIdentifier: z.string().describe('Schedule type identifier: "S" service ticket, "P" project ticket, "C" activity (use get_schedule_types)'),
      memberId:       z.number().optional().describe("Member ID to schedule"),
      memberIdentifier: z.string().optional().describe("Member identifier (login) to schedule, instead of memberId"),
      dateStart:      z.string().describe("Start (ISO 8601)"),
      dateEnd:        z.string().describe("End (ISO 8601)"),
      name:           z.string().optional().describe("Entry name (defaults to the ticket summary)"),
      statusId:       z.number().optional().describe("Schedule status ID"),
      allowScheduleConflictsFlag: z.boolean().optional().describe("Allow overlapping with the member's other entries"),
      notifyResource: z.boolean().optional().describe("Notify the scheduled member"),
    },
    async ({ typeIdentifier, memberId, memberIdentifier, statusId, ...rest }) => {
      if (!memberId && !memberIdentifier) throw new Error("Pass memberId or memberIdentifier");
      const body = clean({
        ...rest,
        type:   { identifier: typeIdentifier },
        member: memberId ? { id: memberId } : { identifier: memberIdentifier },
        status: ref(statusId),
      });
      return json(await cwRequest("POST", "/schedule/entries", {}, body));
    }
  );

  // ══════════════════════════════════════════════════════════════════════════════
  //  SERVICE TICKETS — tasks, board type/subtype/item lookups, create from template
  // ══════════════════════════════════════════════════════════════════════════════

  ticketTaskTools("ticket", "/service/tickets", "service ticket");

  listTool("get_board_types", "List the ticket types on a service board",
    ({ boardId }) => `/service/boards/${boardId}/types`, { boardId: z.number().describe("Service board ID") });
  listTool("get_board_subtypes", "List the ticket subtypes on a service board",
    ({ boardId }) => `/service/boards/${boardId}/subtypes`, { boardId: z.number().describe("Service board ID") });
  listTool("get_board_items", "List the ticket items on a service board",
    ({ boardId }) => `/service/boards/${boardId}/items`, { boardId: z.number().describe("Service board ID") });
  listTool("get_board_type_subtype_items", "List the valid Type/SubType/Item combinations on a service board",
    ({ boardId }) => `/service/boards/${boardId}/typeSubTypeItemAssociations`, { boardId: z.number().describe("Service board ID") });

  server.tool(
    "create_ticket_from_template",
    "Create a ConnectWise service ticket from a service template: copies the template's board, status, type/subtype/item, priority, summary and description, then adds the template's tasks to the new ticket. Fields you pass override the template.",
    {
      templateId:         z.number().describe("Service template ID (use get_service_templates)"),
      companyId:          z.number().describe("Company ID for the ticket"),
      contactId:          z.number().optional().describe("Contact ID"),
      summary:            z.string().optional().describe("Override the template summary"),
      initialDescription: z.string().optional().describe("Override the template description"),
      priorityId:         z.number().optional().describe("Override the template priority"),
      statusId:           z.number().optional().describe("Override the template status"),
    },
    async ({ templateId, companyId, contactId, summary, initialDescription, priorityId, statusId }) => {
      const t = await cwRequest("GET", `/service/templates/${templateId}`);
      const tasks = await cwRequest("GET", `/service/templates/${templateId}/tasks`, { pageSize: 1000, orderBy: "priority asc" });
      const body = clean({
        summary:  summary ?? t.summary ?? t.name,
        company:  { id: companyId },
        contact:  ref(contactId),
        board:    ref(t.board?.id),
        status:   ref(statusId ?? t.status?.id),
        priority: ref(priorityId ?? t.priority?.id),
        type:     ref(t.type?.id),
        subType:  ref(t.subtype?.id ?? t.subType?.id),
        item:     ref(t.item?.id),
        initialDescription: initialDescription ?? t.problem,
      });
      const ticket = await cwRequest("POST", "/service/tickets", {}, body);
      const created = [];
      const failed = [];
      for (const task of tasks || []) {
        try {
          created.push(await cwRequest("POST", `/service/tickets/${ticket.id}/tasks`, {}, clean({
            notes: task.notes, priority: task.priority, code: ref(task.code?.id),
          })));
        } catch (err) {
          failed.push({ templateTaskId: task.id, error: err.message });
        }
      }
      return json({ ticket, tasksCreated: created.length, tasksFailed: failed, tasks: created });
    }
  );

  // ─── helpers scoped to this server instance ────────────────────────────────
  // Registers a paginated GET list tool. `pathFn` gets the tool args; `extra`
  // adds path params (e.g. boardId) to the standard conditions/paging schema.
  function listTool(name, description, pathFn, extra = {}) {
    server.tool(
      name,
      description,
      {
        ...extra,
        conditions: z.string().optional().describe("CW condition string"),
        pageSize:   z.number().optional().describe("Number of results (default 25, max 1000)"),
        page:       z.number().optional().describe("Page number"),
        orderBy:    z.string().optional().describe("Sort order"),
      },
      async (args) => json(await cwRequest("GET", pathFn(args), {
        conditions: args.conditions,
        pageSize:   args.pageSize || 25,
        page:       args.page || 1,
        orderBy:    args.orderBy,
      }))
    );
  }

  // get/create/update/delete tools for tasks on a service or project ticket.
  function ticketTaskTools(prefix, base, label) {
    const ticketId = z.number().describe(`The ${label} ID`);
    listTool(`get_${prefix}_tasks`, `List the tasks (checklist items) on a ConnectWise ${label}`,
      (a) => `${base}/${a.ticketId}/tasks`, { ticketId });

    server.tool(
      `create_${prefix}_task`,
      `Add a task (checklist item) to a ConnectWise ${label}`,
      {
        ticketId,
        notes:      z.string().describe("Task text"),
        priority:   z.number().optional().describe("Order/sequence number (lower = earlier)"),
        summary:    z.string().optional().describe("Short task summary"),
        codeId:     z.number().optional().describe("Service code ID"),
        memberId:   z.number().optional().describe("Assigned member ID"),
        closedFlag: z.boolean().optional().describe("Create it already completed"),
      },
      async ({ ticketId: id, codeId, memberId, ...rest }) =>
        json(await cwRequest("POST", `${base}/${id}/tasks`, {}, clean({ ...rest, code: ref(codeId), member: ref(memberId) })))
    );

    server.tool(
      `update_${prefix}_task`,
      `Update a task on a ConnectWise ${label} (e.g. mark it done with closedFlag=true). Only the fields you pass are changed.`,
      {
        ticketId,
        taskId:     z.number().describe("Task ID"),
        notes:      z.string().optional().describe("New task text"),
        priority:   z.number().optional().describe("New order"),
        summary:    z.string().optional().describe("New summary"),
        resolution: z.string().optional().describe("Resolution text"),
        closedFlag: z.boolean().optional().describe("Complete (true) or reopen (false)"),
        memberId:   z.number().optional().describe("New assigned member ID"),
      },
      async ({ ticketId: id, taskId, ...f }) => {
        const ops = patchOps({
          "/notes": f.notes, "/priority": f.priority, "/summary": f.summary,
          "/resolution": f.resolution, "/closedFlag": f.closedFlag, "/member/id": f.memberId,
        });
        return json(await cwRequest("PATCH", `${base}/${id}/tasks/${taskId}`, {}, ops));
      }
    );

    server.tool(
      `delete_${prefix}_task`,
      `Delete a task from a ConnectWise ${label}. Destructive and not reversible.`,
      { ticketId, taskId: z.number().describe("Task ID to delete") },
      async ({ ticketId: id, taskId }) =>
        json((await cwRequest("DELETE", `${base}/${id}/tasks/${taskId}`)) || { deleted: true, taskId })
    );
  }

  return server;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRANSPORT — stdio (local) or HTTP (Railway)
// ══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT;

// ─── Inbound auth (HTTP mode only) ───────────────────────────────────────────
// This server can create, update and delete ConnectWise records, so every MCP
// request must carry MCP_AUTH_TOKEN, either as
//   Authorization: Bearer <token>        (scripts, agents, anything that sets headers)
//   POST /t/<token>                      (Claude.ai connectors, which cannot set headers)
// With no token configured the server fails closed: /health stays up so Railway
// keeps the deployment, but every MCP request gets 503 until the token is set.
const MCP_AUTH_TOKEN = (process.env.MCP_AUTH_TOKEN || "").trim();
const MIN_TOKEN_LENGTH = 32;
const TOKEN_CONFIGURED = MCP_AUTH_TOKEN.length >= MIN_TOKEN_LENGTH;
const sha256 = (s) => createHash("sha256").update(s).digest();
const EXPECTED_DIGEST = sha256(MCP_AUTH_TOKEN);

function tokenMatches(candidate) {
  // Compare fixed-length digests so neither content nor length leaks via timing.
  return timingSafeEqual(sha256(candidate), EXPECTED_DIGEST);
}

function checkAuth(req) {
  const path = (req.url || "/").split("?")[0];

  // Claude probes for OAuth before connecting. This server has no OAuth, so say
  // "not here" (404) rather than 401, which invites the client to try OAuth.
  if (path.startsWith("/.well-known/") || path === "/register") {
    return { ok: false, status: 404, error: "not found" };
  }

  if (!TOKEN_CONFIGURED) {
    return { ok: false, status: 503, error: "server auth is not configured" };
  }

  const pathMatch = path.match(/^\/t\/([^/]+)\/?$/);
  if (pathMatch) {
    let candidate;
    try { candidate = decodeURIComponent(pathMatch[1]); } catch { candidate = ""; }
    return tokenMatches(candidate)
      ? { ok: true }
      : { ok: false, status: 401, error: "unauthorized" };
  }

  const header = req.headers.authorization || "";
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer && tokenMatches(bearer[1].trim())) return { ok: true };

  return { ok: false, status: 401, error: "unauthorized" };
}

if (PORT && !TOKEN_CONFIGURED) {
  console.error(
    `[auth] MCP_AUTH_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters — ` +
      "every MCP request will be refused with 503 until it is set.",
  );
}

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

    const auth = checkAuth(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }

    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }));
      } else {
        res.end();
      }
    }
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
      if (!body) return resolve(undefined);
      try { resolve(JSON.parse(body)); } catch { resolve(undefined); }
    });
    req.on("error", () => resolve(undefined));
  });
}
