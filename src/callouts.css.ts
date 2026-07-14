/**
 * Styles for Obsidian callouts rendered inside kramdown HTML blocks.
 * Hard-coded light theme: published sites have no Obsidian CSS variables.
 * Keeps kramdown-friendly rules: no regex-required selectors, no user-agent overrides.
 */
export const CALLOUTS_CSS = `.callout {
  padding: 12px 16px;
  margin: 16px 0;
  border-left: 4px solid #448aff;
  border-radius: 4px;
  background: #e3f2fd;
  color: inherit;
  overflow: hidden;
}
.callout > *:first-child {
  margin-top: 0;
}
.callout > *:last-child {
  margin-bottom: 0;
}
.callout-title {
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.callout-icon {
  display: inline-block;
  width: 1.25em;
  text-align: center;
  flex-shrink: 0;
}
.callout details > summary,
.callout > summary {
  cursor: pointer;
}
.callout-note {
  border-color: #448aff;
  background: #e3f2fd;
}
.callout-abstract,
.callout-summary,
.callout-tldr {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-info {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-todo {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-tip,
.callout-hint,
.callout-important {
  border-color: #00bfa5;
  background: #e0f2f1;
}
.callout-success,
.callout-check,
.callout-done {
  border-color: #00c853;
  background: #e8f5e9;
}
.callout-question,
.callout-help,
.callout-faq {
  border-color: #64dd17;
  background: #f1f8e9;
}
.callout-warning,
.callout-caution,
.callout-attention {
  border-color: #ff9100;
  background: #fff3e0;
}
.callout-failure,
.callout-fail,
.callout-missing {
  border-color: #ff5252;
  background: #ffebee;
}
.callout-danger,
.callout-error {
  border-color: #ff1744;
  background: #ffebee;
}
.callout-bug {
  border-color: #f50057;
  background: #ffebee;
}
.callout-example {
  border-color: #7c4dff;
  background: #ede7f6;
}
.callout-quote,
.callout-cite {
  border-color: #9e9e9e;
  background: #f5f5f5;
}
`;
