/**
 * Session Context Builder for Agor System Prompts
 *
 * Builds rich context for Handlebars templates including:
 * - Session information (ID, agent type, permissions)
 * - Branch details (path, branch, notes)
 * - Repository information (name, slug, path)
 *
 * Used by all SDKs (Claude Code, Gemini, Codex) for dynamic system prompts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shortId } from '../lib/ids';
import type { Branch, BranchID, Repo, Session, SessionID, User, UUID } from '../types';
import { renderTemplate } from './handlebars-helpers';

/**
 * Minimal repository interfaces for session context rendering.
 * These allow both ORM repositories and Feathers repositories to be used.
 */
interface SessionRepositoryLike {
  findById(id: SessionID): Promise<Session | null>;
}

interface BranchRepositoryLike {
  findById(id: BranchID): Promise<Branch | null>;
}

interface RepoRepositoryLike {
  findById(id: UUID): Promise<Repo | null>;
}

interface UserRepositoryLike {
  findById(id: string): Promise<User | null>;
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
 * Fetches session, branch, and repo data to provide rich context
 * to agents about their Agor environment.
 *
 * @param sessionId - Current session ID
 * @param repos - Repository instances for data fetching
 * @returns Template context with session/branch/repo data
 */
export async function buildSessionContext(
  sessionId: SessionID,
  repos: {
    sessions: SessionRepositoryLike;
    branches?: BranchRepositoryLike;
    repos?: RepoRepositoryLike;
    users?: UserRepositoryLike;
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

    // Fetch session owner info for display in system prompt.
    // Note: session.created_by is immutable, but name/email are mutable profile fields.
    // A profile rename causes a cache miss on the next turn — acceptable since it's rare.
    if (session.created_by && repos.users) {
      try {
        const owner = await repos.users.findById(session.created_by);
        if (owner) {
          context.owner = {
            name: owner.name || owner.email,
            email: owner.email,
          };
        }
      } catch (err) {
        console.warn(
          `[SessionContext] Failed to fetch owner for session ${shortId(sessionId)}:`,
          err
        );
      }
    }

    // Fetch branch data if session has one
    if (session.branch_id && repos.branches) {
      const branch = await repos.branches.findById(session.branch_id);
      if (branch) {
        context.branch = {
          branch_id: branch.branch_id,
          name: branch.name,
          path: branch.path,
          ref: branch.ref, // Git ref (branch/tag/commit)
          notes: branch.notes,
        };

        // Fetch repo data if branch has one
        if (branch.repo_id && repos.repos) {
          const repo = await repos.repos.findById(branch.repo_id);
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
 * @returns Rendered system prompt with session/branch/repo information
 */
export async function renderAgorSystemPrompt(
  sessionId: SessionID,
  repos: {
    sessions: SessionRepositoryLike;
    branches?: BranchRepositoryLike;
    repos?: RepoRepositoryLike;
    users?: UserRepositoryLike;
  }
): Promise<string> {
  const template = await loadAgorSystemPromptTemplate();
  const context = await buildSessionContext(sessionId, repos);
  return renderTemplate(template, context);
}
