# PHPX Tag Support

**PHPX Tag Support** is a comprehensive Visual Studio Code extension designed to enhance your Prisma PHP development workflow. It provides intelligent tag support, auto-completion, diagnostics, and advanced integrations for PHPX components, Prisma operations, and JavaScript/TypeScript-style templating.

## 🚀 Key Features

### 🏷️ Component Management

- **Smart Auto-Import**: Press `Ctrl+.` on any unimported component to automatically add import statements
- **Intelligent Import Grouping**: Automatically groups imports from the same namespace using curly brace syntax
- **Component Discovery**: Automatically loads components from `class-log.json` for completion suggestions
- **Dynamic Props Validation**: Validates component properties and their allowed values

### 📝 Code Generation

- **PHPX Class Template**: Type `phpxclass` to generate a complete PHPX component template with:
  - Automatic namespace detection based on file location
  - Proper class structure with `render()` method
  - Built-in attribute and class merging support

### 🎯 Intelligent Completion

#### Component Completion

- **Tag Suggestions**: Start typing `<` to see available PHPX components
- **Attribute Completion**: Get suggestions for component properties with type information
- **Value Completion**: Smart completion for attribute values based on component documentation

#### Event Handler Support

- **Function Completion**: Auto-complete PHP functions in `onXXX="..."` attributes
- **Definition Lookup**: Navigate to function definitions with `Ctrl+Click`

#### Mustache Expression Support

- **Variable Completion**: Complete variables and object properties in `{{ }}` expressions
- **Native JS Methods**: Access JavaScript string methods like `.substring()`, `.padStart()`, etc.
- **Template Literals**: Full support for template literals with `${}` placeholder syntax

### 🔍 Navigation & Information

#### Hover Information

- **Component Details**: Hover over tags to see their full import path
- **Method Signatures**: Hover over PPHP methods to see their complete signatures
- **Native JS Help**: Get documentation for JavaScript methods within mustache expressions

#### Go to Definition

- **Component Sources**: Navigate to component source files with `Ctrl+Click`
- **Function Navigation**: Jump to PHP function definitions from event handlers
- **Peek Definition**: Force peek view for better code exploration

### 🛡️ Advanced Diagnostics

#### XML & HTML Validation

- **Tag Pair Matching**: Detect unclosed or mismatched HTML/XML tags
- **Attribute Validation**: Ensure all attributes have proper values
- **Fragment Syntax**: Support for React-style `<></>` fragment syntax

#### Import & Usage Validation

- **Missing Imports**: Automatically detect and flag components without imports
- **Import Suggestions**: Get quick-fix suggestions to add missing imports
- **Heredoc Support**: Validate components within PHP heredoc/nowdoc blocks

#### JavaScript Expression Validation

- **Syntax Checking**: Validate JavaScript expressions in `{{ }}` mustache blocks
- **Assignment Prevention**: Warn against assignments in template expressions
- **Type Safety**: Ensure expressions are valid JavaScript

### ⚙️ PPHP Integration

#### Method Support

- **PPHP Class Methods**: Full completion and validation for `pphp.*` methods
- **Local Store**: Support for `store.*` operations with PPHPLocalStore
- **Search Params**: Integration with `searchParams.*` for URL parameter management

## 🎯 Enumerated Props – strict list vs. list + `*` wildcard

PHPX Tag Support reads `@property` annotations to learn which **string literals** are valid for a prop.

| Annotation style                                                     | Extension behaviour                                                                                                                           | When to use it                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/** @property string $color = success\|warning\|error */`    | **Strict enum** – attribute must be one of the listed tokens.Any other string is flagged as an error.                                 | The set of legal options is finite and you want the linter to be uncompromising (variants, sizes, etc.). |
| `/** @property string $color = success\|warning\|error\|* */` | **Enum + wildcard** – the three presets appear first in IntelliSense, but **any other non-empty string** is also accepted (no red underline). | You have common presets yet still need flexibility (custom CSS colours, dynamic slugs, etc.).            |

### 📌 Component Example

```php
class Badge extends PHPX
{
    /** @property string $color = success|warning|error|* */
    public string $color = 'success';
}
```

#### Signature Help

- **Parameter Information**: Get real-time parameter hints for PPHP method calls
- **Argument Validation**: Ensure correct number and types of arguments

### 🗃️ Prisma Integration

- **Schema Validation**: Real-time validation of Prisma schema changes
- **CRUD Operations**: Validate `create`, `read`, `update`, `delete`, `upsert` operations
- **Advanced Queries**: Support for `groupBy` and `aggregate` operations
- **Field Completion**: Auto-complete Prisma model fields and relationships

### 🎨 Syntax Highlighting

- **Mustache Expressions**: Syntax highlighting for `{{ }}` blocks
- **Template Literals**: Proper coloring for template strings with placeholders
- **Native Methods**: Color-coded JavaScript native methods and properties
- **String & Number Literals**: Enhanced highlighting for different data types
- **Curly Braces**: Visual emphasis on expression boundaries

### 📁 File Management

- **Real-time Updates**: Automatically refresh completions when files change
- **Workspace Integration**: Seamless integration with Prisma PHP projects
- **Class Log Monitoring**: Watch for changes in component definitions

## 📋 Complete Feature List

| Feature Category        | Capabilities                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------- |
| **Auto-Import**         | • Quick fix with `Ctrl+.` • Smart import grouping • Alias support                     |
| **Code Generation**     | • `phpxclass` snippet • Namespace auto-detection • Template scaffolding               |
| **Component Support**   | • Tag completion • Props validation • Attribute suggestions                           |
| **Navigation**          | • Go to definition • Peek definition • Function lookup                                |
| **Diagnostics**         | • Missing imports • XML validation • Syntax errors • Type checking                    |
| **Mustache Templating** | • Variable completion • JS method support • Template literals • Expression validation |
| **PPHP Integration**    | • Method completion • Signature help • Parameter validation • Store management        |
| **Prisma Support**      | • Schema validation • CRUD operations • Field completion • Query validation           |
| **Syntax Highlighting** | • Expression coloring • Method highlighting • String/number literals • Brace matching |
| **Event Handlers**      | • Function completion • Definition lookup • Parameter hints                           |
| **File Watching**       | • Auto-refresh • Cache management • Real-time updates                                 |

## 🛠️ Installation

### From the Marketplace

Search for **PHPX Tag Support** in the Visual Studio Code Marketplace and click **Install**.

### From VSIX File

```bash
code --install-extension phpx-tag-support-0.0.1.vsix
```

## 🚀 Usage Examples

### Creating a New Component

1. Type `phpxclass` in a new PHP file
2. The extension auto-detects the namespace based on your file location
3. Complete PHPX component template is generated

### Auto-Importing Components

1. Type `<ComponentName` in your PHP file
2. Press `Ctrl+.` when you see the "Missing import" warning
3. Choose from available import options
4. Import is automatically added and grouped appropriately

### Using Mustache Expressions

```php
<div class="user-info">
    {{ user.name.substring(0, 10) }}
    {{ `Hello ${user.name}!` }}
    {{ store.getValue('theme') }}
</div>
```

### Event Handler Completion

```php
<Button onClick="handleClick" onSubmit="validateForm">
    Click me
</Button>
```

## ⚙️ Configuration

The extension automatically configures VS Code for optimal PHPX development:

```json
{
  "editor.gotoLocation.single": "peek",
  "editor.gotoLocation.multiple": "peek",
  "phpx-tag-support.sourceRoot": "src"
}
```

## 📁 Project Structure

Your Prisma PHP project should include:

- `prisma-php.json` (project identifier)
- `settings/class-log.json` (component definitions)
- `settings/prisma-schema.json` (Prisma integration)
- `.pphp/phpx-mustache.d.ts` (TypeScript definitions for mustache variables)

## 🎯 Commands

| Command                 | Shortcut     | Description                      |
| ----------------------- | ------------ | -------------------------------- |
| **Add Import**          | `Ctrl+.`     | Auto-import missing components   |
| **Peek Tag Definition** | `F12`        | Show component definition inline |
| **Go to Definition**    | `Ctrl+Click` | Navigate to source file          |

## 🤝 Contributing

Contributions are welcome! This extension supports a wide range of features for modern PHP development with PHPX.

### Development Setup

1. Clone the repository
2. Run `npm install`
3. Open in VS Code and press `F5` to launch extension development host

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

---

**🔥 Pro Tip**: This extension works best in Prisma PHP projects with properly configured `class-log.json` and TypeScript definition files for maximum IntelliSense support!
