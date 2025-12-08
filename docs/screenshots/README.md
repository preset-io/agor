# Screenshot Examples

This directory contains example screenshots demonstrating the screenshot paste feature in Agor's web terminal.

## Files

### `terminal-path-insertion.png`
Shows the terminal after pasting a screenshot, with the file path automatically inserted into the input:
```
@".agor/uploads/Screenshot 2025-12-07 at 8.33.42â€"PM_1765157643226.png"
```

**What to capture:**
- VS Code terminal panel or Agor terminal
- File path visible in terminal input
- Screenshot that was pasted

### `ai-analyzing-screenshot.png`
Shows Claude AI analyzing a pasted screenshot (business process flow diagram) and providing detailed analysis.

**What to capture:**
- Full conversation showing the pasted screenshot reference
- AI's response analyzing the image content
- Clear demonstration of the end-to-end workflow

## Adding Screenshots

Before creating the PR, add the actual screenshot images to this directory with these exact filenames:

```bash
# From project root
cp /path/to/your/screenshot1.png docs/screenshots/terminal-path-insertion.png
cp /path/to/your/screenshot2.png docs/screenshots/ai-analyzing-screenshot.png
```

Then commit:
```bash
git add docs/screenshots/*.png
git commit --amend --no-edit
```

## Image Requirements

- **Format:** PNG (preferred), JPEG, or WEBP
- **Size:** Keep under 2MB for GitHub display
- **Resolution:** At least 800px wide for clarity
- **Content:** Ensure no sensitive information is visible
