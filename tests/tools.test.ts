/**
 * Unit tests for the enrollment tool functions.
 *
 * We create an in-memory mock of the Agent's sql tagged-template function
 * so that we can test each tool independently without a Durable Object.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerStudent,
  listCourses,
  enrollStudent,
  dropCourse,
  checkEnrollment,
  executeTool,
  TOOL_DESCRIPTORS,
} from "../src/tools";
import type { Student, Course, Enrollment } from "../src/utils";
import { SEED_COURSES } from "../src/utils";

// ── In-memory SQL mock ─────────────────────────────────────────────

interface TableRow {
  [key: string]: string | number | boolean | null;
}

/**
 * A simple in-memory SQLite-like mock that supports INSERT, SELECT, UPDATE, DELETE
 * via tagged template literals. Enough for our tool functions.
 */
function createMockSql() {
  const tables: Record<string, TableRow[]> = {
    students: [],
    courses: [],
    enrollments: [],
  };

  let enrollmentIdCounter = 1;

  function sql<T = TableRow>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[] {
    // Reconstruct the query by replacing placeholders
    let query = "";
    for (let i = 0; i < strings.length; i++) {
      query += strings[i];
      if (i < values.length) {
        query += `__PARAM_${i}__`;
      }
    }
    query = query.trim();

    // INSERT
    const insertMatch = query.match(
      /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
    );
    if (insertMatch) {
      const table = insertMatch[1];
      const cols = insertMatch[2].split(",").map((c) => c.trim());
      const valPlaceholders = insertMatch[3].split(",").map((v) => v.trim());
      const row: TableRow = {};

      for (let i = 0; i < cols.length; i++) {
        const ph = valPlaceholders[i];
        const paramMatch = ph.match(/__PARAM_(\d+)__/);
        if (paramMatch) {
          row[cols[i]] = values[parseInt(paramMatch[1])];
        } else {
          row[cols[i]] = ph;
        }
      }

      // Auto-increment for enrollments
      if (table === "enrollments" && !row.id) {
        row.id = enrollmentIdCounter++;
      }

      tables[table].push(row);
      return [] as T[];
    }

    // SELECT with JOIN
    const joinMatch = query.match(
      /SELECT\s+(.+?)\s+FROM\s+(\w+)\s+(\w+)\s+JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\s*(WHERE\s+(.+?))?\s*(ORDER\s+BY\s+(.+?))?\s*$/i
    );
    if (joinMatch) {
      const leftTable = joinMatch[2];
      const leftAlias = joinMatch[3];
      const rightTable = joinMatch[4];
      const rightAlias = joinMatch[5];
      const joinLeftAlias = joinMatch[6];
      const joinLeftCol = joinMatch[7];
      const joinRightAlias = joinMatch[8];
      const joinRightCol = joinMatch[9];
      const whereClause = joinMatch[11];

      let results: TableRow[] = [];

      for (const leftRow of tables[leftTable]) {
        for (const rightRow of tables[rightTable]) {
          // Check join condition
          const leftVal =
            joinLeftAlias === leftAlias
              ? leftRow[joinLeftCol]
              : rightRow[joinLeftCol];
          const rightVal =
            joinRightAlias === rightAlias
              ? rightRow[joinRightCol]
              : leftRow[joinRightCol];

          if (leftVal === rightVal) {
            // Merge with alias-aware naming
            const merged: TableRow = {};
            // Copy all from left
            for (const [k, v] of Object.entries(leftRow)) {
              merged[k] = v;
            }
            // Add aliased columns from right
            for (const [k, v] of Object.entries(rightRow)) {
              // Map "name" from courses to "course_name" based on SELECT
              if (k === "name") {
                merged["course_name"] = v;
              }
              if (k === "instructor") {
                merged["instructor"] = v;
              }
            }
            results.push(merged);
          }
        }
      }

      // Apply WHERE filter
      if (whereClause) {
        results = applyWhere(results, whereClause, values);
      }

      return results as T[];
    }

    // SELECT
    const selectMatch = query.match(
      /SELECT\s+(.+?)\s+FROM\s+(\w+)\s*(WHERE\s+(.+?))?\s*(ORDER\s+BY\s+(.+?))?\s*$/i
    );
    if (selectMatch) {
      const table = selectMatch[2];
      let rows = [...(tables[table] || [])];

      // Apply WHERE
      if (selectMatch[4]) {
        rows = applyWhere(rows, selectMatch[4], values);
      }

      // Handle COUNT(*)
      if (selectMatch[1].includes("COUNT(*)")) {
        return [{ cnt: rows.length } as unknown as T] as T[];
      }

      return rows as T[];
    }

    // UPDATE
    const updateMatch = query.match(
      /UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i
    );
    if (updateMatch) {
      const table = updateMatch[1];
      const setClause = updateMatch[2];
      const whereClause = updateMatch[3];

      const matchingRows = applyWhere(tables[table], whereClause, values);

      for (const row of matchingRows) {
        // Parse SET clause
        const setParts = setClause.split(",").map((s) => s.trim());
        for (const part of setParts) {
          const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
          if (eqMatch) {
            const col = eqMatch[1];
            const valExpr = eqMatch[2].trim();

            // Handle "col + 1" or "col - 1"
            const arithMatch = valExpr.match(/(\w+)\s*([+-])\s*(\d+)/);
            if (arithMatch) {
              const currentVal = row[arithMatch[1]] as number;
              const op = arithMatch[2];
              const delta = parseInt(arithMatch[3]);
              row[col] = op === "+" ? currentVal + delta : currentVal - delta;
            } else {
              const paramMatch2 = valExpr.match(/__PARAM_(\d+)__/);
              if (paramMatch2) {
                row[col] = values[parseInt(paramMatch2[1])];
              }
            }
          }
        }
      }

      return [] as T[];
    }

    // DELETE
    const deleteMatch = query.match(
      /DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)/i
    );
    if (deleteMatch) {
      const table = deleteMatch[1];
      const whereClause = deleteMatch[2];
      const toDelete = applyWhere(tables[table], whereClause, values);

      tables[table] = tables[table].filter((r) => !toDelete.includes(r));
      return [] as T[];
    }

    return [] as T[];
  }

  function applyWhere(
    rows: TableRow[],
    whereClause: string,
    paramValues: (string | number | boolean | null)[]
  ): TableRow[] {
    // Handle AND conditions
    const conditions = whereClause.split(/\s+AND\s+/i);

    return rows.filter((row) => {
      return conditions.every((cond) => {
        const match = cond.trim().match(/(\w+)\.?(\w+)?\s*=\s*(.+)/);
        if (!match) return true;

        // Handle alias.column or just column
        const col = match[2] || match[1];
        const valExpr = match[3].trim();

        const paramMatch = valExpr.match(/__PARAM_(\d+)__/);
        if (paramMatch) {
          const paramVal = paramValues[parseInt(paramMatch[1])];
          return row[col] === paramVal;
        }

        return row[col] === valExpr;
      });
    });
  }

  // Seed courses
  function seedCourses() {
    for (const course of SEED_COURSES) {
      tables.courses.push({
        id: course.id,
        name: course.name,
        instructor: course.instructor,
        capacity: course.capacity,
        enrolled_count: 0,
      });
    }
  }

  function reset() {
    tables.students = [];
    tables.courses = [];
    tables.enrollments = [];
    enrollmentIdCounter = 1;
  }

  return { sql, seedCourses, reset, tables };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Tool Descriptors", () => {
  it("should define 5 tools", () => {
    expect(TOOL_DESCRIPTORS).toHaveLength(5);
  });

  it("should have correct tool names", () => {
    const names = TOOL_DESCRIPTORS.map((t) => t.name);
    expect(names).toContain("register_student");
    expect(names).toContain("list_courses");
    expect(names).toContain("enroll_student");
    expect(names).toContain("drop_course");
    expect(names).toContain("check_enrollment");
  });

  it("each tool should have a description and parameters", () => {
    for (const tool of TOOL_DESCRIPTORS) {
      expect(tool.description).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });
});

describe("registerStudent", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
    mockDb.seedCourses();
  });

  it("should register a new student", () => {
    const result = registerStudent(mockDb.sql, {
      name: "Alice Johnson",
      email: "alice@example.com",
    });
    expect(result).toContain("Student registered successfully");
    expect(result).toContain("Alice Johnson");
    expect(result).toContain("alice@example.com");
    expect(result).toMatch(/STU-[A-Z0-9]+/);
  });

  it("should reject duplicate email", () => {
    registerStudent(mockDb.sql, {
      name: "Alice Johnson",
      email: "alice@example.com",
    });
    const result = registerStudent(mockDb.sql, {
      name: "Alice J",
      email: "alice@example.com",
    });
    expect(result).toContain("already registered");
    expect(result).toContain("alice@example.com");
  });
});

describe("listCourses", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
  });

  it("should list all seeded courses", () => {
    mockDb.seedCourses();
    const result = listCourses(mockDb.sql);
    expect(result).toContain("Available courses:");
    expect(result).toContain("CS101");
    expect(result).toContain("MATH201");
    expect(result).toContain("ENG102");
    expect(result).toContain("PHYS101");
    expect(result).toContain("HIST101");
    expect(result).toContain("Introduction to Computer Science");
    expect(result).toContain("Dr. Smith");
  });

  it("should show no courses when table is empty", () => {
    const result = listCourses(mockDb.sql);
    expect(result).toContain("No courses are currently available");
  });

  it("should show enrollment counts", () => {
    mockDb.seedCourses();
    const result = listCourses(mockDb.sql);
    expect(result).toContain("0/30"); // CS101 capacity
    expect(result).toContain("0/25"); // MATH201 capacity
  });
});

describe("enrollStudent", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
    mockDb.seedCourses();
    // Register a student
    registerStudent(mockDb.sql, {
      name: "Bob Lee",
      email: "bob@example.com",
    });
  });

  function getStudentId(): string {
    return (mockDb.tables.students[0] as { id: string }).id;
  }

  it("should enroll a student in a course", () => {
    const sid = getStudentId();
    const result = enrollStudent(mockDb.sql, {
      student_id: sid,
      course_id: "CS101",
    });
    expect(result).toContain("Successfully enrolled");
    expect(result).toContain(sid);
    expect(result).toContain("CS101");
    expect(result).toContain("Introduction to Computer Science");
  });

  it("should reject enrollment for non-existent student", () => {
    const result = enrollStudent(mockDb.sql, {
      student_id: "FAKE-ID",
      course_id: "CS101",
    });
    expect(result).toContain("not found");
  });

  it("should reject enrollment for non-existent course", () => {
    const sid = getStudentId();
    const result = enrollStudent(mockDb.sql, {
      student_id: sid,
      course_id: "FAKE999",
    });
    expect(result).toContain("not found");
  });

  it("should reject duplicate enrollment", () => {
    const sid = getStudentId();
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "CS101" });
    const result = enrollStudent(mockDb.sql, {
      student_id: sid,
      course_id: "CS101",
    });
    expect(result).toContain("already enrolled");
  });

  it("should reject enrollment when course is full", () => {
    const sid = getStudentId();
    // Set capacity to 0
    const course = mockDb.tables.courses.find(
      (c) => c.id === "PHYS101"
    ) as TableRow;
    course.capacity = 0;
    course.enrolled_count = 0;
    const result = enrollStudent(mockDb.sql, {
      student_id: sid,
      course_id: "PHYS101",
    });
    expect(result).toContain("full");
  });

  it("should increment enrolled_count after enrollment", () => {
    const sid = getStudentId();
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "CS101" });
    const course = mockDb.tables.courses.find(
      (c) => c.id === "CS101"
    ) as TableRow;
    expect(course.enrolled_count).toBe(1);
  });
});

describe("dropCourse", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
    mockDb.seedCourses();
    registerStudent(mockDb.sql, {
      name: "Carol White",
      email: "carol@example.com",
    });
  });

  function getStudentId(): string {
    return (mockDb.tables.students[0] as { id: string }).id;
  }

  it("should drop an enrolled course", () => {
    const sid = getStudentId();
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "MATH201" });
    const result = dropCourse(mockDb.sql, {
      student_id: sid,
      course_id: "MATH201",
    });
    expect(result).toContain("Successfully dropped");
    expect(result).toContain(sid);
    expect(result).toContain("MATH201");
  });

  it("should reject dropping a course not enrolled in", () => {
    const sid = getStudentId();
    const result = dropCourse(mockDb.sql, {
      student_id: sid,
      course_id: "CS101",
    });
    expect(result).toContain("not enrolled");
  });

  it("should decrement enrolled_count after drop", () => {
    const sid = getStudentId();
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "ENG102" });
    const courseBefore = mockDb.tables.courses.find(
      (c) => c.id === "ENG102"
    ) as TableRow;
    expect(courseBefore.enrolled_count).toBe(1);

    dropCourse(mockDb.sql, { student_id: sid, course_id: "ENG102" });
    const courseAfter = mockDb.tables.courses.find(
      (c) => c.id === "ENG102"
    ) as TableRow;
    expect(courseAfter.enrolled_count).toBe(0);
  });
});

describe("checkEnrollment", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
    mockDb.seedCourses();
    registerStudent(mockDb.sql, {
      name: "Dan Green",
      email: "dan@example.com",
    });
  });

  function getStudentId(): string {
    return (mockDb.tables.students[0] as { id: string }).id;
  }

  it("should show no enrollments for new student", () => {
    const sid = getStudentId();
    const result = checkEnrollment(mockDb.sql, { student_id: sid });
    expect(result).toContain("not enrolled in any courses");
  });

  it("should list enrolled courses", () => {
    const sid = getStudentId();
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "CS101" });
    enrollStudent(mockDb.sql, { student_id: sid, course_id: "MATH201" });
    const result = checkEnrollment(mockDb.sql, { student_id: sid });
    expect(result).toContain("CS101");
    expect(result).toContain("MATH201");
    expect(result).toContain("Dan Green");
  });

  it("should reject non-existent student", () => {
    const result = checkEnrollment(mockDb.sql, { student_id: "FAKE-ID" });
    expect(result).toContain("not found");
  });
});

describe("executeTool dispatcher", () => {
  let mockDb: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    mockDb = createMockSql();
    mockDb.seedCourses();
  });

  it("should dispatch register_student", () => {
    const result = executeTool(mockDb.sql, "register_student", {
      name: "Eve",
      email: "eve@example.com",
    });
    expect(result).toContain("Student registered successfully");
  });

  it("should dispatch list_courses", () => {
    const result = executeTool(mockDb.sql, "list_courses", {});
    expect(result).toContain("Available courses:");
  });

  it("should return error for unknown tool", () => {
    const result = executeTool(mockDb.sql, "nonexistent_tool", {});
    expect(result).toContain("Unknown tool");
  });
});

describe("utils", () => {
  it("should export SEED_COURSES with 5 courses", () => {
    expect(SEED_COURSES).toHaveLength(5);
    for (const course of SEED_COURSES) {
      expect(course.id).toBeTruthy();
      expect(course.name).toBeTruthy();
      expect(course.instructor).toBeTruthy();
      expect(course.capacity).toBeGreaterThan(0);
    }
  });
});
