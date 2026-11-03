// Clickable sportsbook odds cell. Clicking opens the native share sheet
// (AirDrop / Messages / Copy) with the bet-slip deep link; browsers without
// navigator.share fall back to the Copy|Open popup. Popup/toast are plain DOM
// (document.createElement) so they survive table re-renders.
// Extracted from App.jsx 2026-07-06 as part of the incremental dissolution.
import { formatOdds } from "../lib/utils.js";

export const BOOK_COLORS = { fanduel: "#2062c8", draftkings: "#0f8a44", hardrockbet: "#c2570f" };
export const BOOK_ABBR   = { fanduel: "FD", draftkings: "DK", hardrockbet: "HR" };
export const BOOK_NAMES  = { fanduel: "FanDuel", draftkings: "DraftKings", hardrockbet: "Hard Rock" };

export function showBetslipToast(bookName) {
  const existing = document.getElementById("betslip-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "betslip-toast";
  toast.textContent = `${bookName} Bet Slip Copied`;
  Object.assign(toast.style, {
    position: "fixed", bottom: "28px", left: "50%", transform: "translateX(-50%)",
    background: "#d7e6fa", color: "#fff", padding: "10px 20px", borderRadius: "8px",
    fontSize: "13px", fontWeight: "600", zIndex: "99999", pointerEvents: "none",
    boxShadow: "0 4px 16px rgba(0,0,0,0.14)", opacity: "1",
    transition: "opacity 0.4s ease",
  });
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; }, 1800);
  setTimeout(() => { toast.remove(); }, 2300);
}

// Dismiss any open odds popup
export function dismissOddsPopup() {
  const el = document.getElementById("odds-popup");
  if (el) el.remove();
  document._oddsPopupDismiss && document.removeEventListener("click", document._oddsPopupDismiss);
}

export function showOddsPopup(url, bookName, anchorEl) {
  dismissOddsPopup();

  const popup = document.createElement("div");
  popup.id = "odds-popup";
  Object.assign(popup.style, {
    position: "fixed",
    background: "#edf2fa",
    border: "1px solid rgba(32,98,200,0.3)",
    borderRadius: "10px",
    padding: "8px 12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "6px",
    zIndex: "99999",
    boxShadow: "0 8px 32px rgba(0,0,0,0.21)",
  });
  popup.style.setProperty("width", "160px", "important");

  const label = document.createElement("div");
  label.textContent = bookName;
  Object.assign(label.style, {
    fontSize: "11px", fontWeight: "700", letterSpacing: "0.08em",
    color: "#6d7c96", textTransform: "uppercase",
  });

  const BTN_VARIANTS = {
    open: { border: "rgba(15,138,68,0.4)", background: "rgba(15,138,68,0.12)", color: "#0f8a44" },
    copy: { border: "rgba(32,98,200,0.3)", background: "rgba(32,98,200,0.192)", color: "#2062c8" },
  };
  const btnStyle = (variant) => {
    const v = BTN_VARIANTS[variant];
    const btn = document.createElement("button");
    Object.assign(btn.style, {
      padding: "6px 0", fontSize: "12px", fontWeight: "600", borderRadius: "6px",
      cursor: "pointer",
      border: `1px solid ${v.border}`,
      background: v.background,
      color: v.color,
    });
    return btn;
  };

  const copyBtn = btnStyle("copy");
  copyBtn.textContent = "Copy Link";
  copyBtn.onclick = (ev) => {
    ev.stopPropagation();
    try { navigator.clipboard.writeText(url); } catch (_) {}
    dismissOddsPopup();
    showBetslipToast(bookName);
  };

  const openBtn = btnStyle("open");
  openBtn.textContent = "Open";
  openBtn.onclick = (ev) => {
    ev.stopPropagation();
    window.open(url, "_blank", "noopener,noreferrer");
    dismissOddsPopup();
  };

  popup.appendChild(label);
  popup.appendChild(openBtn);
  popup.appendChild(copyBtn);
  document.body.appendChild(popup);

  // Position above the anchor element
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left = rect.left + rect.width / 2 - pw / 2;
    let top = rect.top - ph - 8;
    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    if (top < 8) top = rect.bottom + 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  } else {
    popup.style.left = "50%";
    popup.style.top = "50%";
    popup.style.transform = "translate(-50%, -50%)";
  }

  // Dismiss on next click anywhere
  setTimeout(() => {
    document._oddsPopupDismiss = () => dismissOddsPopup();
    document.addEventListener("click", document._oddsPopupDismiss, { once: true });
  }, 0);
}

// Clickable odds cell — FD/DK show Copy|Open popup; HR copies to clipboard
export default function OddsLink({ price, url, isBest, bk, style = {}, align = "right" }) {
  if (price == null) return <span style={{ color: "#c9d5e8", ...style }}>—</span>;
  const color = isBest ? BOOK_COLORS[bk] : "#6d7c96";
  const inner = (
    <span style={{
      fontSize: 11, fontFamily: "'JetBrains Mono',monospace",
      color, fontWeight: isBest ? 700 : 400, cursor: url ? "pointer" : "default",
      textDecoration: "none", ...style,
    }}>
      {formatOdds(price)}
    </span>
  );
  if (!url) return inner;

  const handleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const bookName = BOOK_NAMES[bk] || bk;
    if (typeof navigator.share === "function") {
      // Native share sheet (AirDrop / Messages / Copy). Must run inside the
      // click gesture or the sheet is blocked; rejection = user cancelled.
      navigator.share({ title: `${bookName} Bet Slip`, url }).catch(() => {});
    } else {
      showOddsPopup(url, bookName, e.currentTarget);
    }
  };

  return (
    <span onClick={handleClick} title={`${BOOK_ABBR[bk]} bet slip`} style={{ cursor: "pointer" }}>
      {inner}
    </span>
  );
}
