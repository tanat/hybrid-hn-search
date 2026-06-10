'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ExternalLink } from 'lucide-react';

export type CommentResult = {
  id: number;
  story_id: number;
  story_title: string;
  story_url: string | null;
  author: string;
  text: string;
  points: number;
  score: number;
  rank: number;
};

const STORY_HN_URL = (id: number) => `https://news.ycombinator.com/item?id=${id}`;
const SNIPPET_LEN = 240;

export function CommentCard({
  result,
  position,
}: {
  result: CommentResult;
  position?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = result.text.length > SNIPPET_LEN;
  const snippet = long ? result.text.slice(0, SNIPPET_LEN).trimEnd() + '…' : result.text;

  return (
    <li className="group rounded-xl border border-border bg-card text-card-foreground shadow-xs transition-colors hover:border-border/80 hover:shadow-sm">
      <div className="flex items-start gap-2.5 px-3 pt-3">
        {position != null && (
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
            {position}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <a
            href={result.story_url || STORY_HN_URL(result.story_id)}
            target="_blank"
            rel="noopener noreferrer"
            className="group/title inline-flex items-start gap-1 text-sm font-medium leading-snug hover:text-primary"
          >
            <span className="line-clamp-2">{result.story_title}</span>
            <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100" />
          </a>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/70">{result.author}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{result.points} pts</span>
            <span aria-hidden>·</span>
            <a
              href={STORY_HN_URL(result.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              view on HN
            </a>
          </div>
        </div>
        <Badge
          variant="secondary"
          className="shrink-0 font-mono text-xs tabular-nums"
          title="retrieval score"
        >
          {result.score.toFixed(3)}
        </Badge>
      </div>

      <div className="px-3 pb-3 pt-2">
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {expanded ? result.text : snippet}
        </p>
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {expanded ? 'Show less' : 'Show more'}
            <ChevronDown
              className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>
    </li>
  );
}
