/**
 * Session Context Builder for Agor System Prompts
 *
 * Builds rich context for Handlebars templates including:
 * - Session information (ID, agent type, permissions)
 * - Worktree details (path, branch, notes)
 * - Repository information (name, slug, path)
 *
 * Used by all SDKs (Claude Code, Gemini, Codex) for dynamic system prompts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Repo, Session, SessionID, UUID, Worktree, WorktreeID } from '../types';
import { renderTemplate } from './handlebars-helpers';

/**
 * Minimal repository interfaces for session context rendering.
 * These allow both ORM repositories and Feathers repositories to be used.
 */
interface SessionRepositoryLike {
  findById(id: SessionID): Promise<Session | null>;
}

interface WorktreeRepositoryLike {
  findById(id: WorktreeID): Promise<Worktree | null>;
}

interface RepoRepositoryLike {
  findById(id: UUID): Promise<Repo | null>;
}

/**
 * Load Agor system prompt template from disk
 */
export async function loadAgorSystemPromptTemplate(): Promise<string> {
  const templatePath = path.join(__dirname, 'agor-system-prompt.md');
  return await fs.readFile(templatePath, 'utf-8');
}

/**
 * Build comprehensive session context for template rendering
 *
 * Fetches session, worktree, and repo data to provide rich context
 * to agents about their Agor environment.
 *
 * @param sessionId - Current session ID
 * @param repos - Repository instances for data fetching
 * @returns Template context with session/worktree/repo data
 */
export async function buildSessionContext(
  sessionId: SessionID,
  repos: {
    sessions: SessionRepositoryLike;
    worktrees?: WorktreeRepositoryLike;
    repos?: RepoRepositoryLike;
  }
): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {};

  // Fetch session data
  const session = await repos.sessions.findById(sessionId);
  if (session) {
    context.session = {
      session_id: session.session_id,
      sdk_session_id: session.sdk_session_id, // Claude SDK session ID (for conversation continuity)
      agentic_tool: session.agentic_tool,
      permission_config: session.permission_config || {},
      created_at: session.created_at,
    };

    // Fetch worktree data if session has one
    if (session.worktree_id && repos.worktrees) {
      const worktree = await repos.worktrees.findById(session.worktree_id);
      if (worktree) {
        context.worktree = {
          worktree_id: worktree.worktree_id,
          name: worktree.name,
          path: worktree.path,
          ref: worktree.ref, // Git ref (branch/tag/commit)
          notes: worktree.notes,
        };

        // Fetch repo data if worktree has one
        if (worktree.repo_id && repos.repos) {
          const repo = await repos.repos.findById(worktree.repo_id);
          if (repo) {
            context.repo = {
              repo_id: repo.repo_id,
              name: repo.name,
              slug: repo.slug,
              local_path: repo.local_path,
            };
          }
        }
      }
    }
  }

  return context;
}

/**
 * Render Agor system prompt with full session context
 *
 * Convenience function that loads template and renders with context.
 *
 * @param sessionId - Current session ID
 * @param repos - Repository instances for data fetching
 * @returns Rendered system prompt with session/worktree/repo information
 */
export async function renderAgorSystemPrompt(
  sessionId: SessionID,
  repos: {
    sessions: SessionRepositoryLike;
    worktrees?: WorktreeRepositoryLike;
    repos?: RepoRepositoryLike;
  }
): Promise<string> {
  const template = await loadAgorSystemPromptTemplate();
  const context = await buildSessionContext(sessionId, repos);
  return renderTemplate(template, context);
}
