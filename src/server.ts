/**
 * Student Enrollment Agent — server entry point.
 *
 * This file defines the EnrollmentAgent Durable Object that:
 *   1. Manages a WebSocket-based chat with the user.
 *   2. Calls Llama 3.3 on Workers AI with function-calling
 *      to understand user intent and invoke enrollment tools.
 *   3. Persists students, courses, and enrollments in the
 *      Durable Object's embedded SQLite database.
 *   4. Syncs a lightweight state object to connected clients.
 */

import { Agent, routeAgentRequest } from "agents";
import {
  SEED_COURSES,
  INITIAL_STATE,
  generateId,
  type EnrollmentState,
  type ChatMessage,
  type Course,
} from "./utils";
import { TOOL_DESCRIPTORS, executeTool } from "./tools";

// ── System prompt for the LLM ──────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful student enrollment assistant. You help students register, browse courses, enroll in courses, drop courses, and check their enrollment status.

Available operations (use the provided tools):
- register_student: Register a new student (requires name and email)
- list_courses: Show all available courses with enrollment counts
- enroll_student: Enroll a student in a course (requires student_id and course_id)
- drop_course: Drop a student from a course (requires student_id and course_id)
- check_enrollment: Check what courses a student is enrolled in (requires student_id)

Guidelines:
- Be friendly and concise.
- When a user wants to enroll, first check if they are registered. If not, ask for their name and email to register them.
- Always confirm actions with the user before proceeding.
- After enrolling or dropping, summarize the updated enrollment status.
- If the user asks something unrelated, politely redirect them to enrollment tasks.`;

// ── LLM model identifier ───────────────────────────────────────────

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ── Agent definition ────────────────────────────────────────────────

export class EnrollmentAgent extends Agent<Env, EnrollmentState> {
  initialState: EnrollmentState = INITIAL_STATE;

  /**
   * Called when the Durable Object wakes up (first request or after eviction).
   * We use it to create tables and seed courses if needed.
   */
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        instructor TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        enrolled_count INTEGER NOT NULL DEFAULT 0
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        FOREIGN KEY (student_id) REFERENCES students(id),
        FOREIGN KEY (course_id) REFERENCES courses(id),
        UNIQUE(student_id, course_id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS chat_history (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL
      )
    `;

    // Seed courses if the table is empty
    const existing = this.sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM courses`;
    if (existing[0].cnt === 0) {
      for (const course of SEED_COURSES) {
        this.sql`INSERT INTO courses (id, name, instructor, capacity, enrolled_count) VALUES (${course.id}, ${course.name}, ${course.instructor}, ${course.capacity}, 0)`;
      }
    }

    // Sync course list into shared state
    this._syncState();
  }

  /**
   * Handle HTTP requests — used for the chat endpoint.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/chat") && request.method === "POST") {
      return this._handleChat(request);
    }

    if (url.pathname.endsWith("/history") && request.method === "GET") {
      return this._handleHistory();
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Chat handling ───────────────────────────────────────────────

  private async _handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message: string };
    const userMessage = body.message?.trim();
    if (!userMessage) {
      return Response.json({ error: "Empty message" }, { status: 400 });
    }

    // Save user message
    const userMsg: ChatMessage = {
      id: generateId(),
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    this._saveMessage(userMsg);

    // Build conversation history for LLM (last 20 messages for context)
    const history = this.sql<ChatMessage>`
      SELECT role, content FROM chat_history ORDER BY timestamp DESC LIMIT 20
    `.reverse();

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    // Call LLM with tools
    const assistantContent = await this._callLLM(messages);

    // Save assistant response
    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: "assistant",
      content: assistantContent,
      timestamp: new Date().toISOString(),
    };
    this._saveMessage(assistantMsg);

    // Sync state to clients
    this._syncState();

    return Response.json({
      reply: assistantContent,
      state: this.state,
    });
  }

  private _handleHistory(): Response {
    const messages = this.sql<ChatMessage>`
      SELECT id, role, content, timestamp FROM chat_history ORDER BY timestamp ASC
    `;
    return Response.json({ messages });
  }

  // ── LLM interaction with tool-calling loop ───────────────────────

  private async _callLLM(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    // We allow up to 5 rounds of tool calls before forcing a final answer
    const maxRounds = 5;

    for (let round = 0; round < maxRounds; round++) {
      const response = (await this.env.AI.run(MODEL, {
        messages,
        tools: TOOL_DESCRIPTORS,
        max_tokens: 1024,
      })) as {
        response?: string;
        tool_calls?: Array<{
          name: string;
          arguments: Record<string, string>;
        }>;
      };

      // If the model returned tool calls, execute them and feed results back
      if (response.tool_calls && response.tool_calls.length > 0) {
        // Add the assistant's tool-call intent to the conversation
        const toolCallSummary = response.tool_calls
          .map((tc) => `[Calling ${tc.name}(${JSON.stringify(tc.arguments)})]`)
          .join("\n");

        messages.push({
          role: "assistant",
          content: toolCallSummary,
        });

        // Execute each tool and add results
        for (const toolCall of response.tool_calls) {
          const result = executeTool(
            ((strings: TemplateStringsArray, ...values: (string | number | boolean | null)[]) => this.sql(strings, ...values)),
            toolCall.name,
            toolCall.arguments
          );
          messages.push({
            role: "user",
            content: `Tool result for ${toolCall.name}: ${result}`,
          });
        }

        // Continue loop to let the LLM produce a natural response
        continue;
      }

      // Model gave a text response — we're done
      if (response.response) {
        return response.response;
      }

      // Fallback
      return "I'm sorry, I couldn't process that request. Could you rephrase?";
    }

    return "I completed the requested operations. Is there anything else I can help you with?";
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private _saveMessage(msg: ChatMessage) {
    this.sql`INSERT INTO chat_history (id, role, content, timestamp) VALUES (${msg.id}, ${msg.role}, ${msg.content}, ${msg.timestamp})`;
  }

  private _syncState() {
    const courses = this.sql<Course>`SELECT * FROM courses ORDER BY id`;
    const studentId = this.state.currentStudentId;

    let enrolledCourses: string[] = [];
    if (studentId) {
      const enrollments = this.sql<{ course_id: string }>`
        SELECT course_id FROM enrollments WHERE student_id = ${studentId}
      `;
      enrolledCourses = enrollments.map((e) => e.course_id);
    }

    this.setState({
      ...this.state,
      availableCourses: courses,
      enrolledCourses,
    });
  }
}

// ── Worker entry point ──────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
