/**
 * Shared types and constants for the student enrollment application.
 */

/** A course available for enrollment. */
export interface Course {
  id: string;
  name: string;
  instructor: string;
  capacity: number;
  enrolled_count: number;
}

/** A student record. */
export interface Student {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

/** An enrollment linking a student to a course. */
export interface Enrollment {
  id: number;
  student_id: string;
  course_id: string;
  enrolled_at: string;
}

/** The state synced between agent and connected clients. */
export interface EnrollmentState {
  currentStudentId: string | null;
  currentStudentName: string | null;
  enrolledCourses: string[];
  availableCourses: Course[];
}

/** Chat message structure for our simple chat protocol. */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/** Initial state for a new agent instance. */
export const INITIAL_STATE: EnrollmentState = {
  currentStudentId: null,
  currentStudentName: null,
  enrolledCourses: [],
  availableCourses: [],
};

/** Seed courses pre-loaded into the system. */
export const SEED_COURSES: Omit<Course, "enrolled_count">[] = [
  {
    id: "CS101",
    name: "Introduction to Computer Science",
    instructor: "Dr. Smith",
    capacity: 30,
  },
  {
    id: "MATH201",
    name: "Linear Algebra",
    instructor: "Dr. Johnson",
    capacity: 25,
  },
  {
    id: "ENG102",
    name: "English Composition",
    instructor: "Prof. Williams",
    capacity: 35,
  },
  {
    id: "PHYS101",
    name: "Physics I",
    instructor: "Dr. Brown",
    capacity: 20,
  },
  {
    id: "HIST101",
    name: "World History",
    instructor: "Prof. Davis",
    capacity: 40,
  },
];

/** Generate a simple unique ID. */
export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}
