# PHPX Tag Support

**PHPX Tag Support** is a Visual Studio Code extension designed to enhance your PHP development workflow by adding custom tag support for PHPX. It provides features like hover information, definition lookup, and diagnostic warnings for missing tag imports. The extension also intelligently parses PHP `use` statements—including group imports and aliases—to determine the correct source file for a tag.

## Features

### Hover Provider

Hover over a PHPX tag (e.g., `<GoogleSearch />`) to see a tooltip displaying the full class imported via the corresponding `use` statement.

### Definition Provider

Ctrl+Click (or F12) on a tag opens the Peek Definition view, showing the contents of the source file. The extension ensures that even single definitions use the peek view by updating VS Code’s configuration.

### Diagnostic Warnings

The extension scans your PHP files for custom tags and flags any tag without a corresponding `use` import. It supports group imports and aliasing to ensure accurate diagnostics.

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
code --install-extension your-extension-name.vsix
```

## Usage

### Hover Over Tags

Hover over a tag like `<GoogleSearch />` in your PHP file to see information about its corresponding import.

### Peek Definition

Ctrl+Click (or F12) on a tag opens the inline Peek Definition view. Alternatively, use the command palette command **PHPX: Peek Tag Definition** (`phpx-tag-support.peekTagDefinition`) to manually open the peek view.

### Diagnostics

If a tag is missing its import, a warning (e.g., “Missing import for component `<Toggle />`”) will be shown inline.

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
