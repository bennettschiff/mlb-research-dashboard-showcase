// Tiny inline spinner + label. Extracted from App.jsx so standalone component
// files (e.g. LeadersBoard) can share it without importing back from App.jsx.
export default function Loader({ text = "Loading..." }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "30px 0", color: "#5d6f8b" }}>
      <div className="spin" style={{ width: 18, height: 18, border: "2px solid #c9d5e8", borderTopColor: "#2062c8", borderRadius: "50%" }} />
      <span style={{ fontSize: 13, letterSpacing: 0.5 }}>{text}</span>
    </div>
  );
}
