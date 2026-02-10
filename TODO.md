## cf_ai_cloudflare

Goal: build a simple student enrollment application on Cloudflare with cloudflare's agents. Please refer to https://developers.cloudflare.com/agents/?utm_content=agents.cloudflare.com.


This student enrollment application should include the following components:
 - LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice.
 - Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
 - User input via chat or voice (recommend using Pages or Realtime)
 - Memory or state


Deliverables:
 - Come up with a simple application that include all components mentioned above. This application does not to be complicated, just including simple student enrollment logics, simple and clear is sufficient.
 - Add a `README.md` with project documentation on the project and clear running instructions to try out components (either locally or via deployed link
 - Make a comprehensive markdown book to explain the codebase to let beginners to understand what and why in the code.
 - You must include all important AI prompts used in `PROMPTS.md`


---

## Task Breakdown

### High Priority

#### Task 1: Project Scaffolding & Configuration [HIGH]
Set up the Cloudflare Workers project with all necessary configuration files.

- [x] 1.1: Initialize project structure (package.json, tsconfig.json, wrangler.jsonc, vite.config.ts, vitest.config.ts, index.html, env.d.ts, .gitignore, .dev.vars.example)
- [x] 1.2: Create the backend Agent server (src/server.ts) — EnrollmentAgent Durable Object with Workers AI (Llama 3.3 70B), chat handling via HTTP POST, function-calling tool loop, state sync
- [x] 1.3: Create the tool definitions (src/tools.ts) — 5 enrollment tools: register_student, list_courses, enroll_student, drop_course, check_enrollment
- [x] 1.4: Create the React frontend chat UI (src/app.tsx, src/client.tsx, src/styles.css) — chat interface with WebSocket state sync and HTTP chat endpoint
- [x] 1.5: Create utility helpers (src/utils.ts) — shared types (Course, Student, Enrollment, EnrollmentState, ChatMessage), constants, seed data

#### Task 2: Core Enrollment Logic & State Management [HIGH]
Implement the student enrollment business logic with persistent state.

- [x] 2.1: Define data models and SQL schema for students, courses, and enrollments — created in EnrollmentAgent.onStart() with SQLite tables
- [x] 2.2: Implement enrollment operations (enroll, drop, list, status check) as tool functions with validation (capacity checks, duplicate prevention, existence checks)
- [x] 2.3: Implement state synchronization between agent and frontend — WebSocket state sync via useAgent hook, course list and enrollment status broadcast

#### Task 3: Testing [HIGH]
Add comprehensive test coverage.

- [x] 3.1: Unit tests for enrollment logic — 24 tests covering register, enroll, drop, list, check, validation rules, edge cases
- [x] 3.2: Unit tests for tool definitions and argument parsing — tool descriptor validation, executeTool dispatcher tests
- [x] 3.3: Integration tests for the agent server — 29 tests covering request routing, chat handler, tool-calling loop (single/multi-step/parallel/max-rounds), history endpoint, state synchronization, and end-to-end enrollment flow via mock harness

### Medium Priority

#### Task 4: Documentation [MEDIUM]
- [x] 4.1: Write README.md with project overview, architecture diagram, setup instructions, usage examples, and development guide
- [x] 4.2: Write PROMPTS.md documenting all AI prompts — system prompt, 5 tool descriptors, conversation format, tool-result feedback loop, and design rationale
- [x] 4.3: Write comprehensive codebase guide (docs/GUIDE.md) — message flow diagram, file-by-file walkthrough, config explanations, design decisions rationale, and glossary
