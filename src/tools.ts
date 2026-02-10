/**
 * Tool definitions for the enrollment agent.
 *
 * These functions are the "business logic" that the LLM can call
 * via function-calling. Each tool receives structured arguments
 * and returns a plain-text result for the LLM to incorporate
 * into its response.
 */

import type { Course, Student, Enrollment } from "./utils";

/**
 * Helper type for the SQL tagged-template function available on Agent instances.
 */
type SqlFn = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

// ── Tool descriptors for Workers AI function-calling ────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "register_student",
    description:
      "Register a new student in the system. Returns the student ID.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full name of the student" },
        email: { type: "string", description: "Email address of the student" },
      },
      required: ["name", "email"],
    },
  },
  {
    name: "list_courses",
    description:
      "List all available courses with their current enrollment counts and remaining capacity.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "enroll_student",
    description: "Enroll a student in a course.",
    parameters: {
      type: "object",
      properties: {
        student_id: { type: "string", description: "The student ID" },
        course_id: {
          type: "string",
          description: "The course ID (e.g. CS101)",
        },
      },
      required: ["student_id", "course_id"],
    },
  },
  {
    name: "drop_course",
    description: "Drop (unenroll) a student from a course.",
    parameters: {
      type: "object",
      properties: {
        student_id: { type: "string", description: "The student ID" },
        course_id: {
          type: "string",
          description: "The course ID to drop (e.g. CS101)",
        },
      },
      required: ["student_id", "course_id"],
    },
  },
  {
    name: "check_enrollment",
    description:
      "Check all courses a student is currently enrolled in.",
    parameters: {
      type: "object",
      properties: {
        student_id: { type: "string", description: "The student ID" },
      },
      required: ["student_id"],
    },
  },
];

// ── Tool execution functions ────────────────────────────────────────

export function registerStudent(
  sql: SqlFn,
  args: { name: string; email: string }
): string {
  // Check if email already exists
  const existing = sql<Student>`SELECT * FROM students WHERE email = ${args.email}`;
  if (existing.length > 0) {
    return `Student already registered with email ${args.email}. Student ID: ${existing[0].id}`;
  }

  const id = "STU-" + Math.random().toString(36).substring(2, 8).toUpperCase();
  sql`INSERT INTO students (id, name, email, created_at) VALUES (${id}, ${args.name}, ${args.email}, ${new Date().toISOString()})`;
  return `Student registered successfully. Student ID: ${id}, Name: ${args.name}, Email: ${args.email}`;
}

export function listCourses(sql: SqlFn): string {
  const courses = sql<Course>`SELECT * FROM courses ORDER BY id`;
  if (courses.length === 0) {
    return "No courses are currently available.";
  }
  const lines = courses.map(
    (c) =>
      `- ${c.id}: ${c.name} (Instructor: ${c.instructor}, Enrolled: ${c.enrolled_count}/${c.capacity})`
  );
  return "Available courses:\n" + lines.join("\n");
}

export function enrollStudent(
  sql: SqlFn,
  args: { student_id: string; course_id: string }
): string {
  // Verify student exists
  const students = sql<Student>`SELECT * FROM students WHERE id = ${args.student_id}`;
  if (students.length === 0) {
    return `Error: Student ${args.student_id} not found. Please register first.`;
  }

  // Verify course exists
  const courses = sql<Course>`SELECT * FROM courses WHERE id = ${args.course_id}`;
  if (courses.length === 0) {
    return `Error: Course ${args.course_id} not found.`;
  }
  const course = courses[0];

  // Check capacity
  if (course.enrolled_count >= course.capacity) {
    return `Error: Course ${args.course_id} (${course.name}) is full (${course.capacity}/${course.capacity}).`;
  }

  // Check duplicate enrollment
  const existing = sql<Enrollment>`SELECT * FROM enrollments WHERE student_id = ${args.student_id} AND course_id = ${args.course_id}`;
  if (existing.length > 0) {
    return `Student ${args.student_id} is already enrolled in ${args.course_id}.`;
  }

  // Enroll
  sql`INSERT INTO enrollments (student_id, course_id, enrolled_at) VALUES (${args.student_id}, ${args.course_id}, ${new Date().toISOString()})`;
  sql`UPDATE courses SET enrolled_count = enrolled_count + 1 WHERE id = ${args.course_id}`;

  return `Successfully enrolled student ${args.student_id} (${students[0].name}) in ${args.course_id} (${course.name}).`;
}

export function dropCourse(
  sql: SqlFn,
  args: { student_id: string; course_id: string }
): string {
  // Verify enrollment exists
  const existing = sql<Enrollment>`SELECT * FROM enrollments WHERE student_id = ${args.student_id} AND course_id = ${args.course_id}`;
  if (existing.length === 0) {
    return `Student ${args.student_id} is not enrolled in ${args.course_id}.`;
  }

  sql`DELETE FROM enrollments WHERE student_id = ${args.student_id} AND course_id = ${args.course_id}`;
  sql`UPDATE courses SET enrolled_count = enrolled_count - 1 WHERE id = ${args.course_id}`;

  return `Successfully dropped student ${args.student_id} from course ${args.course_id}.`;
}

export function checkEnrollment(
  sql: SqlFn,
  args: { student_id: string }
): string {
  // Verify student exists
  const students = sql<Student>`SELECT * FROM students WHERE id = ${args.student_id}`;
  if (students.length === 0) {
    return `Error: Student ${args.student_id} not found.`;
  }

  const enrollments = sql<Enrollment & { course_name: string; instructor: string }>`
    SELECT e.*, c.name as course_name, c.instructor
    FROM enrollments e
    JOIN courses c ON e.course_id = c.id
    WHERE e.student_id = ${args.student_id}
    ORDER BY e.enrolled_at
  `;

  if (enrollments.length === 0) {
    return `Student ${students[0].name} (${args.student_id}) is not enrolled in any courses.`;
  }

  const lines = enrollments.map(
    (e) => `- ${e.course_id}: ${e.course_name} (Instructor: ${e.instructor}, Enrolled: ${e.enrolled_at})`
  );
  return `Enrollments for ${students[0].name} (${args.student_id}):\n` + lines.join("\n");
}

/**
 * Dispatch a tool call by name.
 */
export function executeTool(
  sql: SqlFn,
  name: string,
  args: Record<string, string>
): string {
  switch (name) {
    case "register_student":
      return registerStudent(sql, args as { name: string; email: string });
    case "list_courses":
      return listCourses(sql);
    case "enroll_student":
      return enrollStudent(sql, args as { student_id: string; course_id: string });
    case "drop_course":
      return dropCourse(sql, args as { student_id: string; course_id: string });
    case "check_enrollment":
      return checkEnrollment(sql, args as { student_id: string });
    default:
      return `Unknown tool: ${name}`;
  }
}
