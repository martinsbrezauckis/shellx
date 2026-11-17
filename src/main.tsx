/**
 * src/main.tsx — React entry point for the ShellX renderer.
 *
 * Loads (in order):
 *   1. Onest Variable font
 *   2. tokens.css — palette + spacing + base body styles
 *   3. App.css — ordered ownership modules for the ShellX application shell
 *   4. <App/> root component
 *
 * All app surfaces live in components/ and compose inside App.tsx.
 */
import { mountShellxApp } from "./mount-shellx-app";

mountShellxApp();
