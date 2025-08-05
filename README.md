# PHPX Tag Support

**PHPX Tag Support** is a comprehensive Visual Studio Code extension designed to enhance your Prisma PHP development workflow. It provides intelligent tag support, auto-completion, diagnostics, and advanced integrations for PHPX components, Prisma operations, and JavaScript/TypeScript-style templating.

---

## 🚀 Key Features

### 🏷️ Component Management

- **Smart Auto-Import**: Press `Ctrl+.` on any unimported component to automatically add import statements
- **Intelligent Import Grouping**: Automatically groups imports from the same namespace using curly brace syntax
- **Component Discovery**: Automatically loads components from `class-log.json` for completion suggestions
- **Dynamic Props Validation**: Validates component properties and their allowed values

---

### 📝 Code Generation

- **PHPX Class Template**: Type `phpxclass` to generate a complete PHPX component template with:
  - Automatic namespace detection based on file location
  - Proper class structure with `render()` method
  - Built-in attribute and class merging support

---

### 🎯 Intelligent Completion

- **Component Completion**

  - Tag Suggestions: Start typing `<` to see available PHPX components
  - Attribute Completion: Get suggestions for component properties with type information
  - Value Completion: Smart completion for attribute values based on component documentation

- **Event Handler Support**

  - Function Completion: Auto-complete PHP functions in `onXXX="..."` attributes
  - Definition Lookup: Navigate to function definitions with `Ctrl+Click`

- **Mustache Expression Support**
  - Variable Completion: Complete variables and object properties in `{{ }}` expressions
  - Native JS Methods: Access JavaScript string methods like `.substring()`, `.padStart()`, etc.
  - Template Literals: Full support for template literals with `${}` placeholder syntax

---

### 🗺️ Route Management

#### Intelligent Route Completion

- **Auto-Complete Routes**: Get intelligent suggestions for internal routes in `href=""` attributes
- **Real-Time Validation**: Automatically validate route URLs against your actual routes
- **File Path Integration**: Uses `files-list.json` for route detection

#### Route Discovery

- Scans all `index.php` files in your `/app/` directory
- Converts paths to clean URLs:
  - `./src/app/index.php` → `/`
  - `./src/app/dashboard/index.php` → `/dashboard`
  - `./src/app/users/profile/index.php` → `/users/profile`

#### Smart Link Validation

- Invalid Route Detection: Warns about broken links
- External URL Support: Ignores `https://`, `mailto:`, `tel:`, `#` links
- Live Updates: Watches `files-list.json` for changes

#### Route Navigation

- **Go to Route File**: `Ctrl+Click` on `href` to open `index.php`
- **Hover Details**: Shows file path and route info
- **Route Explorer**: Use "Show All Available Routes"
- **Manual Refresh**: Use "Refresh Routes" command

#### 📌 Route Example

```html
<!-- ✅ Auto-completed internal routes -->
<a href="/">Home</a>
<a href="/dashboard">Dashboard</a>
<a href="/users/profile">User Profile</a>

<!-- ❌ Invalid route (shows warning) -->
<a href="/non-existent-page">Broken Link</a>

<!-- ✅ External -->
<a href="https://example.com">External Site</a>
<a href="mailto:user@example.com">Send Email</a>
<a href="#section">Page Anchor</a>
```

---

### 🔍 Navigation & Information

- **Hover Information**

  - View component imports, JS method docs, and method signatures

- **Go to Definition**
  - Jump to component/function definitions
  - Supports peek view

---

### 🛡️ Advanced Diagnostics

#### XML & HTML Validation

- Tag Pair Matching
- Attribute Validation
- Support for fragment syntax (`<>...</>`)

#### Import & Usage Validation

- Missing Imports
- Quick-fix suggestions
- Heredoc support

#### JavaScript Expression Validation

- Syntax Checking
- Assignment Prevention
- Type Safety

---

### ⚙️ PPHP Integration

- **Method Support**
  - Completion for `pphp._`, `store._`, `searchParams._`
  - Signature Help and Argument Hints

---

### 🎯 Enumerated Props – strict list vs. list + `*` wildcard

| Annotation style                                              | Extension behaviour                                      | When to use it                        |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| `/** @property string $color = success\|warning\|error */`    | **Strict enum** – attribute must match one of the tokens | For finite sets like variants         |
| `/** @property string $color = success\|warning\|error\|* */` | **Enum + wildcard** – suggests presets but allows custom | For extensible values like CSS colors |

#### 📌 Component Example

```php
class Badge extends PHPX
{
    /** @property string $color = success|warning|error|* */
    public string $color = 'success';
}
```

---

### 🗃️ Prisma Integration

- **Schema Validation**
- **CRUD Support**: create, read, update, delete, upsert
- **Advanced Queries**: groupBy, aggregate
- **Field Completion**: model fields & relations

---

### 🎨 Syntax Highlighting

- Mustache Expressions (`{{ }}`)
- Template Literals (`${}`)
- JS Native Methods
- String/Number Literals
- Curly Braces Highlighting

---

### 📁 File Management

- Real-time Updates on File Changes
- Project Integration with `class-log.json`
- Monitors file changes for auto-refresh

---

## 📋 Complete Feature List

| Feature Category    | Capabilities                                |
| ------------------- | ------------------------------------------- |
| Auto-Import         | Ctrl+., grouped imports, alias support      |
| Code Generation     | `phpxclass`, namespace detection            |
| Component Support   | Tag, props, attributes                      |
| Route Management    | Autocomplete, validation, refresh           |
| Navigation          | Go to definition, peek, Ctrl+Click          |
| Diagnostics         | Imports, XML/JS validation                  |
| Mustache Templating | Variable, method, and expression validation |
| PPHP Integration    | Methods, store, searchParams                |
| Prisma Support      | Schema, CRUD, queries                       |
| Syntax Highlighting | Expressions, strings, JS methods            |
| Event Handlers      | Completion, lookup, hints                   |
| File Watching       | Refresh, cache, updates                     |

---

## 🛠️ Installation

### From the Marketplace

Search for `PHPX Tag Support` in the **VS Code Marketplace** and click **Install**.

### From VSIX File

```bash
code --install-extension phpx-tag-support-0.0.1.vsix
```

---

## 🚀 Usage Examples

### Creating a New Component

- Type `phpxclass` in a new file
- Generates full component scaffold

### Auto-Importing Components

- Type `<ComponentName`
- Press `Ctrl+.` to auto-import

### Using Mustache Expressions

```html
<div class="user-info">
  {{ user.name.substring(0, 10) }} {{ `Hello ${user.name}!` }} {{
  store.getValue('theme') }}
</div>
```

### Event Handler Completion

```php
<Button onClick="handleClick" onSubmit="validateForm">
    Click me
</Button>
```

### Route Management

```html
<nav class="menu">
  <a href="/">Home</a>
  <!-- ✅ -->
  <a href="/dashboard">Dashboard</a>
  <!-- ✅ -->
  <a href="/users">Users</a>
  <!-- ✅ -->
  <a href="/invalid">Invalid</a>
  <!-- ❌ -->
</nav>

<a href="/orm/group-by">Group By</a>
<!-- Ctrl+Click -->
```

---

## ⚙️ Configuration

```json
{
  "editor.gotoLocation.single": "peek",
  "editor.gotoLocation.multiple": "peek",
  "phpx-tag-support.sourceRoot": "src"
}
```

---

## 📁 Project Structure

Ensure your Prisma PHP project includes:

- `prisma-php.json` – project identifier
- `settings/class-log.json` – component definitions
- `settings/files-list.json` – route definitions
- `settings/prisma-schema.json` – Prisma integration
- `.pphp/phpx-mustache.d.ts` – TypeScript for Mustache

---

## 🎯 Commands

| Command             | Shortcut     | Description                    |
| ------------------- | ------------ | ------------------------------ |
| Add Import          | Ctrl+.       | Auto-import missing components |
| Peek Tag Definition | F12          | Show tag definition inline     |
| Go to Definition    | Ctrl+Click   | Navigate to source file        |
| Go to Route File    | Ctrl+Click   | Navigate to route's index.php  |
| Refresh Routes      | Ctrl+Shift+P | Manually refresh route cache   |
| Show All Routes     | Ctrl+Shift+P | Display all available routes   |

---

## 🤝 Contributing

Contributions are welcome! This extension supports a wide range of features for modern PHP development with PHPX.

### Development Setup

```bash
git clone https://github.com/your-repo/phpx-tag-support.git
cd phpx-tag-support
npm install
```

- Open in **VS Code**
- Press `F5` to launch the extension development host

---

## 📄 License

Licensed under the **MIT License**.  
See the [LICENSE](./LICENSE) file for details.

---

🔥 **Pro Tip:** This extension works best in Prisma PHP projects with properly configured `class-log.json`, `files-list.json`, and TypeScript definitions for maximum IntelliSense support!
