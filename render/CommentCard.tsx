'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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

export function CommentCard({ result }: { result: CommentResult }) {
  const [expanded, setExpanded] = useState(false);
  const snippet = result.text.length > 250 ? result.text.slice(0, 250) + '…' : result.text;

  return (
    <Card className="mb-3">
      <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={result.story_url || STORY_HN_URL(result.story_id)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium hover:underline line-clamp-1"
          >
            {result.story_title}
          </a>
          <div className="text-xs text-muted-foreground mt-1">
            {result.author}
            {' · '}
            <a
              href={STORY_HN_URL(result.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              comment #{result.rank}
            </a>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <Badge variant="secondary" className="text-xs">
            {result.score.toFixed(3)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent
        className="pt-0 cursor-pointer text-sm leading-relaxed whitespace-pre-wrap"
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? 'click to collapse' : 'click to expand'}
      >
        {expanded ? result.text : snippet}
      </CardContent>
    </Card>
  );
}
