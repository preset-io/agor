# Agor FAQ

Frequently Asked Questions about Agor

---

## Git & Repository Management

### How do I work with private GitHub repositories in Agor?

Agor can work with private GitHub repositories, but you need to ensure your machine is properly authenticated with GitHub first.

**Authentication Methods:**

You can use either SSH or HTTPS authentication:

1. **SSH Keys** (Recommended)
   - Configure SSH keys on your machine for SSH-based cloning
   - Follow [GitHub's SSH key setup guide](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)
   - Test with: `ssh -T git@github.com`

2. **HTTPS with Credentials**
   - Set up HTTP credentials for Git/GitHub operations
   - Use credential helpers or personal access tokens

**GitHub CLI (Highly Recommended):**

Install the `gh` CLI tool at the operating system level and authenticate it:

```bash
# Install gh (varies by OS)
brew install gh  # macOS
# or follow: https://cli.github.com/manual/installation

# Authenticate
gh auth login
```

The agents work exceptionally well with the `gh` CLI, using it for:
- Repository creation
- Issue management
- Pull request operations
- GitHub Actions log access
- And more

**Advanced Integration:**

For deeper GitHub integration capabilities, consider installing and using the GitHub MCP (Model Context Protocol) tool, which provides additional GitHub-related functionality for AI agents.

**Troubleshooting:**

If you're seeing authentication errors when cloning private repos:
1. Verify your authentication: `gh auth status`
2. Test cloning manually: `git clone <your-private-repo-url>`
3. Ensure the authenticated user has access to the repository
4. Check that your SSH keys or tokens are properly configured

---

_Have more questions? [Open an issue](https://github.com/preset-io/agor/issues) or check out the [documentation](README.md)._
