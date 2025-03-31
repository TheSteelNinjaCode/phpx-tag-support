# PHPX Tag Support

**PHPX Tag Support** is a Visual Studio Code extension designed to enhance your Prisma PHP development workflow by adding custom tag support for PHPX. It provides features like hover information, definition lookup, diagnostic warnings for missing tag imports, and intelligent parsing of PHP `use` statements—including group imports and aliases. Additionally, it includes completion suggestions for PHPX tags and advanced diagnostics for XML attributes and tag pairs.

## Features

### Hover Provider

Hover over a PHPX tag (e.g., `<GoogleSearch />`) to see a tooltip displaying the full class imported via the corresponding `use` statement. If the tag is not found, a helpful message is displayed.

### Definition Provider

Ctrl+Click (or F12) on a tag opens the Peek Definition view, showing the contents of the source file. The extension ensures that even single definitions use the peek view by updating VS Code’s configuration. It also supports resolving definitions using a `class-log.json` file or `use` imports.

### Diagnostic Warnings

The extension scans your PHP files for custom tags and flags any tag without a corresponding `use` import. It supports group imports, aliasing, and heredoc/nowdoc filtering to ensure accurate diagnostics. Additional validations include:

- Missing XML attribute values in "XML mode."
- Unmatched or improperly closed tags.

### Tag Completion Suggestions

Provides intelligent completion suggestions for PHPX tags based on `use` imports. Suggestions are triggered when typing `<` in PHP files.

### Group Import & Alias Support

Handles PHP `use` statements like:

```php
use Lib\PHPX\PPIcons\{Search as GoogleSearch, Toggle};
```

This allows you to use `<GoogleSearch />` and `<Toggle />` without additional configuration.

### Heredoc/Nowdoc Filtering

To avoid false positives, the extension ignores tags found inside PHP heredoc/nowdoc blocks.

## Installation

### From the Marketplace

Search for **PHPX Tag Support** in the Visual Studio Code Marketplace and click **Install**.

### From a VSIX File

Package the extension into a `.vsix` file (using `vsce package`) and install it via:

```bash
code --install-extension phpx-tag-support-0.0.1.vsix
```

## Usage

### Hover Over Tags

Hover over a tag like `<GoogleSearch />` in your PHP file to see information about its corresponding import.

### Peek Definition

Ctrl+Click (or F12) on a tag opens the inline Peek Definition view. Alternatively, use the command palette command **PHPX: Peek Tag Definition** (`phpx-tag-support.peekTagDefinition`) to manually open the peek view.

### Diagnostics

If a tag is missing its import, a warning (e.g., “⚠️ Missing import for component `<Toggle />`”) will be shown inline. Additional diagnostics include:

- Warnings for missing XML attribute values.
- Errors for unmatched or improperly closed tags.

### Completion Suggestions

Start typing `<` in a PHP file to see suggestions for available PHPX tags based on your `use` imports.

## Extension Commands

- **PHPX Tag Support: Hover Provider**  
   Command: `phpx-tag-support.hoverProvider`  
   Displays a "Hello World" message (example command).

- **PHPX Tag Support: Peek Tag Definition**  
   Command: `phpx-tag-support.peekTagDefinition`  
   Opens the built-in Peek Definition view for the current tag.

## Configuration

This extension automatically updates the following settings to force Peek Definition for Go to Definition:

```json
"editor.gotoLocation.single": "peek",
"editor.gotoLocation.multiple": "peek"
```

You can disable or modify this behavior in your VS Code settings if preferred.

## Contributing

Contributions are welcome! Fork this repository and submit a pull request with your changes. For bugs or feature requests, please use the issue tracker.

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
