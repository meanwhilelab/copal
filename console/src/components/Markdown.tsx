import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders markdown as themed React elements (GitHub-flavored: tables, task lists,
 * strikethrough, autolinks). react-markdown does NOT emit raw HTML, so
 * agent/LLM-authored content can't inject scripts. Styling lives in the `.md`
 * prose block in index.css; links open in a new tab.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
