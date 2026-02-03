# Archived Documentation

This directory contains documentation that has been superseded by newer implementations or consolidated into other docs.

These files are kept for historical reference and to understand the evolution of Agor's design.

---

## Archived Files

### Unix Integration Explorations (Archived 2025-02-03)

- **`unix-user-integration.md`** - Original exploration of sudo-based impersonation
- **`unix-user-modes.md`** - Deep dive on Unix isolation modes

**Why archived:**
These exploration docs have been successfully implemented and their content consolidated into:
- `context/guides/rbac-and-unix-isolation.md` - Complete implementation guide
- `apps/agor-docs/pages/guide/multiplayer-unix-isolation.mdx` - User-facing setup guide
- `docker/sudoers/agor-daemon.sudoers` - Production sudoers configuration

The implemented system follows the design from these explorations closely, with these key refinements:
- Three clear modes: simple, insulated, strict
- Production-ready sudoers file with extensive documentation
- Path scoping for all filesystem operations
- `agor_users` group for scoped impersonation

---

## When to Archive

Documentation should be moved to archives when:
1. The exploration has been fully implemented
2. The content has been consolidated into canonical docs
3. The file is no longer maintained or updated
4. The information is outdated but worth preserving for context

Always add an entry here explaining why the doc was archived and where to find the current information.
