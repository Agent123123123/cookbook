/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IAgentSessionContextUsage } from './agentSessionService.js';

class CircularProgressIndicator {

	readonly domNode: SVGSVGElement;

	private readonly _progressCircle: SVGCircleElement;
	private readonly _circumference: number;

	private static readonly _centerX = 18;
	private static readonly _centerY = 18;
	private static readonly _radius = 14;

	constructor() {
		const radius = CircularProgressIndicator._radius;
		this._circumference = 2 * Math.PI * radius;

		this.domNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.domNode.setAttribute('viewBox', '0 0 36 36');
		this.domNode.classList.add('agent-mode-context-usage__progress');

		const backgroundCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		backgroundCircle.setAttribute('cx', String(CircularProgressIndicator._centerX));
		backgroundCircle.setAttribute('cy', String(CircularProgressIndicator._centerY));
		backgroundCircle.setAttribute('r', String(radius));
		backgroundCircle.classList.add('progress-bg');
		this.domNode.appendChild(backgroundCircle);

		this._progressCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		this._progressCircle.setAttribute('cx', String(CircularProgressIndicator._centerX));
		this._progressCircle.setAttribute('cy', String(CircularProgressIndicator._centerY));
		this._progressCircle.setAttribute('r', String(radius));
		this._progressCircle.classList.add('progress-arc');
		this._progressCircle.setAttribute('stroke-dasharray', String(this._circumference));
		this._progressCircle.setAttribute('stroke-dashoffset', String(this._circumference));
		this.domNode.appendChild(this._progressCircle);
	}

	setProgress(percentage: number): void {
		const clamped = Math.max(0, Math.min(100, percentage));
		const offset = this._circumference - (clamped / 100) * this._circumference;
		this._progressCircle.setAttribute('stroke-dashoffset', String(offset));
	}
}

const numberFormatter = new Intl.NumberFormat();

export class AgentModeContextUsageWidget {

	readonly domNode: HTMLElement;

	private readonly _progressIndicator: CircularProgressIndicator;
	private readonly _percentageLabel: HTMLElement;

	constructor() {
		this.domNode = document.createElement('div');
		this.domNode.className = 'agent-mode-context-usage';
		this.domNode.style.display = 'none';
		this.domNode.setAttribute('role', 'img');
		this.domNode.setAttribute('aria-label', localize('agentModeContextUsageUnavailable', 'Context window usage unavailable'));

		const iconContainer = document.createElement('div');
		iconContainer.className = 'agent-mode-context-usage__icon';
		this._progressIndicator = new CircularProgressIndicator();
		iconContainer.appendChild(this._progressIndicator.domNode);

		this._percentageLabel = document.createElement('span');
		this._percentageLabel.className = 'agent-mode-context-usage__percentage';

		this.domNode.append(iconContainer, this._percentageLabel);
	}

	update(contextUsage: IAgentSessionContextUsage | undefined): void {
		if (!contextUsage || contextUsage.totalContextWindow <= 0 || contextUsage.usedTokens < 0) {
			this._hide();
			return;
		}

		const percentage = Math.max(0, contextUsage.percentage);
		const roundedPercentage = Math.min(100, Math.round(percentage));
		const ariaLabel = localize(
			'agentModeContextUsageAriaLabel',
			"Context window usage: {0}% ({1} of {2} tokens)",
			roundedPercentage,
			numberFormatter.format(contextUsage.usedTokens),
			numberFormatter.format(contextUsage.totalContextWindow)
		);

		this._progressIndicator.setProgress(percentage);
		this._percentageLabel.textContent = `${roundedPercentage}%`;
		this.domNode.setAttribute('aria-label', ariaLabel);
		this.domNode.title = ariaLabel;
		this.domNode.classList.toggle('warning', percentage >= 75 && percentage < 90);
		this.domNode.classList.toggle('error', percentage >= 90);
		this._show();
	}

	private _show(): void {
		this.domNode.style.display = '';
	}

	private _hide(): void {
		this.domNode.style.display = 'none';
		this.domNode.classList.remove('warning', 'error');
		this.domNode.removeAttribute('title');
	}
}
