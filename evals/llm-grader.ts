import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { gateway, generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';

export type GraderProvider = 'gemini' | 'claude' | 'openai';

const GRADE_SCHEMA = z.object({
  grade: z.number().int().min(0).max(3),
  reasoning: z.string(),
});

const SYSTEM_PROMPT = `You are a relevance judge for a search engine over Hacker News comments.

Grade how relevant the comment is to the query on this scale:
3 - Highly relevant: directly and substantially addresses the query
2 - Partially relevant: clearly related to the topic but not a direct answer
1 - Tangential: mentions the topic but doesn't meaningfully address it
0 - Irrelevant: unrelated to the query

When in doubt between adjacent grades, lean lower.
Grade relevance to the query, not writing quality.`;

function getModel(provider: GraderProvider): LanguageModel {
  if (provider === 'gemini') {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
    return google('gemini-2.5-flash') as unknown as LanguageModel;
  }
  if (provider === 'openai') return gateway('openai/gpt-4o-mini');
  return gateway('anthropic/claude-haiku-4-5-20251001');
}

export async function llmGrade(
  provider: GraderProvider,
  query: string,
  commentText: string,
  storyTitle: string,
): Promise<{ grade: 0 | 1 | 2 | 3; reasoning: string }> {
  const { output } = await generateText({
    model: getModel(provider),
    output: Output.object({ schema: GRADE_SCHEMA }),
    system: SYSTEM_PROMPT,
    prompt: `Query: "${query}"\n\nComment (from story: "${storyTitle}"):\n${commentText}`,
  });
  return { grade: output.grade as 0 | 1 | 2 | 3, reasoning: output.reasoning };
}
