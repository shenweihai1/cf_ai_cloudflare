# AI Prompts Reference

This document lists every AI prompt and LLM interaction pattern used in the Student Enrollment Agent application.

## Model

| Setting | Value |
|---|---|
| Model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (Llama 3.3 70B, FP8 quantized) |
| Provider | Cloudflare Workers AI |
| Max tokens | 1024 per response |
| Tool-call rounds | Up to 5 per user message |

## 1. System Prompt

**Location:** `src/server.ts`, line 26 — `SYSTEM_PROMPT` constant

**Purpose:** Sets the LLM's role, lists the tools it can use, and defines behavioral guidelines. Sent as the first message (with `role: "system"`) in every LLM call.

```
You are a helpful student enrollment assistant. You help students register, browse courses, enroll in courses, drop courses, and check their enrollment status.

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
- If the user asks something unrelated, politely redirect them to enrollment tasks.
```

### Design rationale

- **Role declaration** ("You are a helpful student enrollment assistant") anchors the model's behavior to enrollment tasks.
- **Tool listing in the prompt** reinforces the function-calling tool descriptors (see section 2), since some models benefit from seeing tool names in natural language as well as in the structured `tools` parameter.
- **Guidelines** prevent the model from going off-topic and ensure it follows a consistent interaction pattern (register before enroll, confirm before acting, summarize after changes).

## 2. Tool Descriptors (Function-Calling Definitions)

**Location:** `src/tools.ts`, line 32 — `TOOL_DESCRIPTORS` array

**Purpose:** Passed to the Workers AI API in the `tools` parameter alongside each LLM call. These tell the model what structured actions it can invoke and what arguments each requires.

### 2.1 `register_student`

```json
{
  "name": "register_student",
  "description": "Register a new student in the system. Returns the student ID.",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Full name of the student" },
      "email": { "type": "string", "description": "Email address of the student" }
    },
    "required": ["name", "email"]
  }
}
```

### 2.2 `list_courses`

```json
{
  "name": "list_courses",
  "description": "List all available courses with their current enrollment counts and remaining capacity.",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### 2.3 `enroll_student`

```json
{
  "name": "enroll_student",
  "description": "Enroll a student in a course.",
  "parameters": {
    "type": "object",
    "properties": {
      "student_id": { "type": "string", "description": "The student ID" },
      "course_id": { "type": "string", "description": "The course ID (e.g. CS101)" }
    },
    "required": ["student_id", "course_id"]
  }
}
```

### 2.4 `drop_course`

```json
{
  "name": "drop_course",
  "description": "Drop (unenroll) a student from a course.",
  "parameters": {
    "type": "object",
    "properties": {
      "student_id": { "type": "string", "description": "The student ID" },
      "course_id": { "type": "string", "description": "The course ID to drop (e.g. CS101)" }
    },
    "required": ["student_id", "course_id"]
  }
}
```

### 2.5 `check_enrollment`

```json
{
  "name": "check_enrollment",
  "description": "Check all courses a student is currently enrolled in.",
  "parameters": {
    "type": "object",
    "properties": {
      "student_id": { "type": "string", "description": "The student ID" }
    },
    "required": ["student_id"]
  }
}
```

### Design rationale

- **JSON Schema format** is the standard that Workers AI function-calling expects. Each tool has a `name`, `description`, and `parameters` object with JSON Schema types.
- **Descriptions are action-oriented** ("Register a new student", "Enroll a student in a course") so the LLM can match user intent to the right tool.
- **Parameter descriptions include examples** where helpful (e.g., "The course ID (e.g. CS101)") to reduce hallucinated argument values.

## 3. Conversation Message Format

**Location:** `src/server.ts`, `_handleChat()` method (line 124) and `_callLLM()` method (line 180)

**Purpose:** Defines how the conversation is assembled before sending to the LLM.

Each LLM call receives a `messages` array in this order:

```
[
  { role: "system",    content: SYSTEM_PROMPT },
  { role: "user",      content: "<earliest of last 20 messages>" },
  { role: "assistant", content: "..." },
  { role: "user",      content: "..." },
  ...
  { role: "user",      content: "<latest user message>" }
]
```

- The **system prompt** is always first.
- The **last 20 messages** from `chat_history` (stored in SQLite) provide conversational context.
- A **context window of 20 messages** is a practical limit — enough for multi-turn conversations while fitting within the model's 24K token context window.

## 4. Tool-Result Feedback Pattern

**Location:** `src/server.ts`, `_callLLM()` method (lines 200–226)

**Purpose:** After the LLM returns a `tool_calls` response (instead of a text response), the agent executes each tool and feeds the results back to the LLM so it can produce a natural-language reply.

The feedback loop works as follows:

```
Round 1:
  → Send messages + tools to LLM
  ← LLM returns: tool_calls: [{ name: "list_courses", arguments: {} }]

  Append to messages:
    { role: "assistant", content: "[Calling list_courses({})]" }
    { role: "user",      content: "Tool result for list_courses: Available courses:\n- CS101: ..." }

Round 2:
  → Send updated messages + tools to LLM
  ← LLM returns: { response: "Here are the available courses: ..." }

  → Return text response to user
```

### Design rationale

- **Tool-call summaries** are added as assistant messages so the LLM can "see" what it decided to do.
- **Tool results** are added as user messages (a common pattern for function-calling) so the LLM treats them as new information to incorporate into its reply.
- **Up to 5 rounds** prevents infinite loops if the model keeps requesting tool calls. After 5 rounds, a fallback message is returned.
- **Multiple tool calls** in a single round are supported — all are executed and their results are fed back together.

## 5. Prompt Engineering Notes

### What works well

- **Explicit tool listing in the system prompt** complements the structured `tools` parameter. Llama 3.3 is more reliable at choosing tools when it can see the names and their purpose in plain English.
- **"Always confirm actions"** guideline prevents the model from immediately executing enrollment changes without user confirmation, giving a better UX.
- **"Politely redirect"** for off-topic questions keeps the conversation focused without being abrupt.

### Potential improvements

- **Few-shot examples** in the system prompt could improve reliability for complex multi-step operations (e.g., register then immediately enroll).
- **Structured output format** (e.g., requesting Markdown tables for course listings) could improve readability, but would add prompt complexity.
- **Student context tracking** — the system prompt could be dynamically augmented with the current student's ID and name once registered, reducing the need for the model to remember or look up this information.
