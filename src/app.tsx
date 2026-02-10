import { useState, useRef, useEffect, useCallback } from "react";
import { useAgent } from "agents/react";
import type { EnrollmentState, ChatMessage, Course } from "./utils";

/**
 * Main chat UI for the student enrollment agent.
 *
 * Communicates with the EnrollmentAgent Durable Object via:
 *   - WebSocket (useAgent hook) for real-time state sync
 *   - HTTP POST /chat for sending messages
 */
export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [enrolledCourses, setEnrolledCourses] = useState<string[]>([]);
  const [availableCourses, setAvailableCourses] = useState<Course[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Connect to the agent via WebSocket for state sync
  useAgent<EnrollmentState>({
    agent: "EnrollmentAgent",
    onStateUpdate: (state: EnrollmentState) => {
      setEnrolledCourses(state.enrolledCourses ?? []);
      setAvailableCourses(state.availableCourses ?? []);
    },
  });

  // Load chat history on mount
  useEffect(() => {
    fetch("/agents/EnrollmentAgent/default/history")
      .then((res) => res.json())
      .then((data) => {
        const parsed = data as { messages?: ChatMessage[] };
        if (parsed.messages) {
          setMessages(parsed.messages);
        }
      })
      .catch(() => {
        // History fetch failed — start fresh
      });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    setLoading(true);

    // Optimistic UI: show user message immediately
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await fetch("/agents/EnrollmentAgent/default/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as {
        reply: string;
        state: EnrollmentState;
      };

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "Sorry, something went wrong. Please try again.",
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <div>
          <h1>Student Enrollment Assistant</h1>
          <p>
            Powered by Llama 3.3 on Cloudflare Workers AI
            {availableCourses.length > 0 &&
              ` | ${availableCourses.length} courses available`}
          </p>
        </div>
      </div>

      <div className="messages">
        {messages.length === 0 && !loading && (
          <div className="message system">
            Welcome! I can help you register as a student, browse courses,
            enroll in courses, drop courses, or check your enrollment status.
            How can I help you today?
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}

        {loading && <div className="typing-indicator">Thinking...</div>}

        <div ref={messagesEndRef} />
      </div>

      {enrolledCourses.length > 0 && (
        <div className="sidebar">
          <h3>Your Enrolled Courses</h3>
          {enrolledCourses.map((courseId) => (
            <span key={courseId} className="course-tag">
              {courseId}
            </span>
          ))}
        </div>
      )}

      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (e.g., 'Show me available courses')"
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
