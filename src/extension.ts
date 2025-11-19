// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

/**
* Basic, pragmatic parser for C/C++ function prototypes in header files and implementations in .cpp
* - Not a full parser — uses regex heuristics and line-based ranges
* - Good foundation to iterate on (AST-based parser could replace heuristics)
*/


type Prototype = {
	name: string;
	signature: string; // full text of prototype
	range: vscode.Range; // line-range in header
};


type Implementation = {
	name: string;
	signatureLine: number; // line where definition starts
	range: vscode.Range; // start..end of function implementation in file
	file: vscode.Uri;
};

// In-memory cache keyed by header URI
const headerCache = new Map<string, Prototype[]>();

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.commands.registerCommand('header-orderer.scanHeader', scanCurrentHeader),
		vscode.commands.registerCommand('header-orderer.findImpls', findImplsForActiveHeader),
		vscode.commands.registerCommand('header-orderer.syncOrder', syncOrderForActiveHeader)
	);


	vscode.window.showInformationMessage('Header Orderer extension activated (foundation).');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('header-orderer.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from HeaderOrderer!');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() { }


// ---------------------------
// Helpers
// ---------------------------


function isHeaderDocument(doc: vscode.TextDocument) {
	return doc.languageId === 'cpp' || doc.fileName.endsWith('.h') || doc.fileName.endsWith('.hpp');
}


/**
* Very simple heuristic to find prototypes in header text.
* Matches lines ending with ";" and not part of typedefs or macros.
*/
function parsePrototypesFromText(doc: vscode.TextDocument): Prototype[] {
	const prototypes: Prototype[] = [];
	const text = doc.getText();
	const lines = text.split(/\r?\n/);


	// We'll attempt a multi-line scan: collect contiguous lines until a semicolon is found.
	let buffer: string[] = [];
	let bufferStart = 0;


	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();


		// skip preprocessor directives and comments start
		if (/^\s*#/.test(line)) { buffer = []; continue; }


		// If buffer empty and line looks like comment-only, skip
		if (buffer.length === 0 && /^\/\//.test(trimmed)) { continue; }


		buffer.push(line);
		if (buffer.length === 1) bufferStart = i;


		// if this line contains a semicolon that is not inside quotes (heuristic)
		if (/;\s*$/.test(line)) {
			const combined = buffer.join('\n').trim();


			// rough filter: must contain '(' and ')' and not start with 'typedef' or 'using'
			if (combined.includes('(') && combined.includes(')') && !/^\s*(typedef|using)\b/.test(combined)) {
				// extract function name by regex: something like "... name ( ... ) ;"
				const nameMatch = combined.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g);
				let name = '';
				if (nameMatch) {
					// take last match before '('
					const m = nameMatch[nameMatch.length - 1];
					name = m.replace(/\s*\($/, '').trim();
				}


				if (name) {
					const start = new vscode.Position(bufferStart, 0);
					const end = new vscode.Position(i, lines[i].length);
					prototypes.push({ name, signature: combined, range: new vscode.Range(start, end) });
				}
			}


			buffer = [];
		}


		// if buffer grows too big, reset (avoid huge macros)
		if (buffer.length > 20) buffer = [];
	}


	return prototypes;
}


/**
* Find function implementations in workspace files (very rough heuristic)
* We search for `<name>\s*\(` followed by ")" and then a "{" on the same line or following lines.
*/
async function findImplementationsForPrototypes(prototypes: Prototype[]): Promise<Implementation[]> {
	const impls: Implementation[] = [];


	// Build a quick name -> prototype map for lookup
	const names = new Set(prototypes.map(p => p.name));
	if (names.size === 0) return impls;


	// Search in workspace for likely implementation files: .cpp, .cc, .cxx, .c
	const files = await vscode.workspace.findFiles('**/*.{cpp,cc,cxx,c,hpp,ccpp}', '**/node_modules/**', 200);


	// Iterate files and scan text
	for (const file of files) {
		try {
			const doc = await vscode.workspace.openTextDocument(file);
			const text = doc.getText();
			const lines = text.split(/\r?\n/);


			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// skip comments
				if (/^\s*\/\//.test(line)) continue;


				// naive: find any occurrence of a name followed by '(' on this line
				for (const name of names) {
					const idx = line.indexOf(name + '(');
					if (idx === -1) continue;


					// Try to verify it's a definition (there will be a '{' after the parameter list)
					// We'll scan forward up to N lines to find the opening '{'.
					let foundBrace = false;
					let braceLine = i;
					for (let j = i; j < Math.min(lines.length, i + 30); j++) {
						if (lines[j].includes('{')) { foundBrace = true; braceLine = j; break; }
						// stop if we hit a line that ends with ';' -> likely a declaration
						if (/;\s*$/.test(lines[j])) break;
					}


					if (!foundBrace) continue;


					// Now find matching brace to determine function end — naive stack scan
					let depth = 0;
					let endLine = braceLine;
					let started = false;
					for (let j = braceLine; j < lines.length; j++) {
						const l = lines[j];
						for (const ch of l) {
							if (ch === '{') { depth++; started = true; }
							else if (ch === '}') { depth--; }
						}
						if (started && depth === 0) { endLine = j; break; }
					}


					const startPos = new vscode.Position(i, 0);
					const endPos = new vscode.Position(endLine, lines[endLine].length);
					impls.push({ name, signatureLine: i, range: new vscode.Range(startPos, endPos), file });
				}
			}


		} catch (e) {
			// ignore file read errors
		}
	}


	return impls;
}


// ---------------------------
// Commands
// ---------------------------


async function scanCurrentHeader() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showErrorMessage('Open a header file (*.h, *.hpp) to scan.'); return; }
	const doc = editor.document;
	if (!isHeaderDocument(doc)) { vscode.window.showErrorMessage('Active document is not recognized as a header.'); return; }


	const prototypes = parsePrototypesFromText(doc);
	headerCache.set(doc.uri.toString(), prototypes);


	vscode.window.showInformationMessage(`Found ${prototypes.length} prototype(s) in ${doc.fileName}`);
}

async function findImplsForActiveHeader() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showErrorMessage('Open a header file first.'); return; }
	const doc = editor.document;
	const cached = headerCache.get(doc.uri.toString());
	if (!cached) { vscode.window.showErrorMessage('No cached prototypes — run "Scan Header" first.'); return; }


	const impls = await findImplementationsForPrototypes(cached);
	vscode.window.showInformationMessage(`Found ${impls.length} implementation(s) across workspace for header ${doc.fileName}`);


	// Show quick pick to open one
	const items = impls.map(i => ({ label: `${i.name} — ${vscode.workspace.asRelativePath(i.file)}`, impl: i }));
	const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Open implementation...' });
	if (pick) {
		const d = await vscode.workspace.openTextDocument(pick.impl.file);
		await vscode.window.showTextDocument(d, { preview: false });
		const editor2 = vscode.window.activeTextEditor;
		if (editor2) editor2.revealRange(pick.impl.range, vscode.TextEditorRevealType.InCenter);
	}
}

/**
* Sync order of functions in implementation file by header's prototype order.
* Strategy (heuristic): for a chosen .cpp file, extract functions that match header names, reorder their text blocks to match header order and replace selected region in file.
*/
async function syncOrderForActiveHeader() {
	const headerEditor = vscode.window.activeTextEditor;
	if (!headerEditor) { vscode.window.showErrorMessage('Open a header file and run Scan Header first.'); return; }
	const headerDoc = headerEditor.document;
	const prototypes = headerCache.get(headerDoc.uri.toString());
	if (!prototypes || prototypes.length === 0) { vscode.window.showErrorMessage('No prototypes cached. Run "Scan Header" first.'); return; }


	// Ask user to pick a target implementation file
	const impls = await findImplementationsForPrototypes(prototypes);
	if (impls.length === 0) { vscode.window.showErrorMessage('No implementations found in workspace.'); return; }


	const files = Array.from(new Map(impls.map(i => [i.file.toString(), i.file])).values());
	const pick = await vscode.window.showQuickPick(files.map(f => ({ label: vscode.workspace.asRelativePath(f), file: f })), { placeHolder: 'Choose .cpp to reorder functions' });
	if (!pick) return;


	const doc = await vscode.workspace.openTextDocument(pick.file);
	const editor = await vscode.window.showTextDocument(doc, { preview: false });
	const text = doc.getText();


	// Collect implementations from this file only
	const fileImpls = impls.filter(i => i.file.toString() === pick.file.toString());
	if (fileImpls.length === 0) { vscode.window.showInformationMessage('No implementations from selected header found in this file.'); return; }


	// Build a map name -> impl
	const implMap = new Map<string, Implementation>();
	for (const impl of fileImpls) implMap.set(impl.name, impl);


	// Build new file content by iterating lines and replacing function blocks with placeholders
	const lines = text.split(/\r?\n/);


	// We'll build list of blocks to reorder: each block has startLine,endLine,text,name
	const blocks: { name: string; start: number; end: number; text: string }[] = [];
	for (const impl of fileImpls) {
		const start = impl.range.start.line;
		const end = impl.range.end.line;
		const blockText = lines.slice(start, end + 1).join('\n');
		blocks.push({ name: impl.name, start, end, text: blockText });
	}


	// Sort header prototypes by their order in header
	const orderedNames = prototypes.map(p => p.name);
	const orderedBlocks: string[] = [];
	for (const name of orderedNames) {
		const b = blocks.find(x => x.name === name);
		if (b) orderedBlocks.push(b.text);
	}


	if (orderedBlocks.length === 0) { vscode.window.showInformationMessage('No matching functions to reorder in chosen file.'); return; }


	// For simplicity, we'll replace from minStart to maxEnd with concatenation of orderedBlocks
	const minStart = Math.min(...blocks.map(b => b.start));
	const maxEnd = Math.max(...blocks.map(b => b.end));


	const edit = new vscode.WorkspaceEdit();
	const range = new vscode.Range(new vscode.Position(minStart, 0), new vscode.Position(maxEnd, lines[maxEnd].length));
	const newText = orderedBlocks.join('\n\n');
	edit.replace(doc.uri, range, newText);


	const ok = await vscode.workspace.applyEdit(edit);
	if (ok) {
		await doc.save();
		vscode.window.showInformationMessage('Reordered functions to match header prototype order.');
	} else {
		vscode.window.showErrorMessage('Failed to apply edits.');
	}
}