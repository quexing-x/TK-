import {
  BookOpen,
  CalendarDays,
  ExternalLink,
  Info,
  ShieldAlert,
} from "lucide-react";
import { userGuide } from "@tk-auto/manual";

export function ManualPage() {
  return (
    <section className="manual-layout">
      <aside className="manual-index panel">
        <div className="manual-index-heading">
          <BookOpen size={19} />
          <div>
            <strong>使用手册</strong>
            <span>版本 {userGuide.version}</span>
          </div>
        </div>
        <nav>
          {userGuide.sections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
        </nav>
      </aside>

      <div className="manual-content">
        <header className="manual-hero">
          <span className="manual-hero-icon"><BookOpen size={26} /></span>
          <div>
            <span className="eyebrow">置顶操作指南</span>
            <h2>{userGuide.title}</h2>
            <p>{userGuide.summary}</p>
            <div className="manual-meta">
              <span><CalendarDays size={14} /> 更新于 {userGuide.updatedAt}</span>
              <span><Info size={14} /> Web 与 Markdown 同源</span>
            </div>
          </div>
        </header>

        {userGuide.sections.map((section) => (
          <article className="manual-section panel" id={section.id} key={section.id}>
            <h3>{section.title}</h3>
            <p className="manual-intro">{section.intro}</p>
            <ol>
              {section.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {section.links && section.links.length > 0 && (
              <div className="manual-links">
                {section.links.map((link) => (
                  <a href={link.url} key={link.url} rel="noreferrer" target="_blank">
                    {link.label} <ExternalLink size={13} />
                  </a>
                ))}
              </div>
            )}
            {section.notes.length > 0 && (
              <div className="manual-notes">
                <ShieldAlert size={18} />
                <div>
                  <strong>注意事项</strong>
                  <ul>
                    {section.notes.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
