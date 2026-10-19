import { svg, message } from './compute.ts';

const diagram = document.querySelector('figure');
const status = document.querySelector('output');
if (!diagram || !status) throw new Error('Missing example elements.');
diagram.innerHTML = svg;
status.textContent = message;
