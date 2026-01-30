/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

// Air-gapped: Telemetry disabled - dom import not needed
// import * as dom from '../../../../base/browser/dom.js';
import { IMetricsService } from '../common/metricsService.js';



export interface IMetricsPollService {
	readonly _serviceBrand: undefined;
}


// Air-gapped: Telemetry disabled - ping interval not used
// const PING_EVERY_MS = 15 * 1000 * 60  // 15 minutes

export const IMetricsPollService = createDecorator<IMetricsPollService>('voidMetricsPollService');
class MetricsPollService extends Disposable implements IMetricsPollService {
	_serviceBrand: undefined;

	static readonly ID = 'voidMetricsPollService';

	// Air-gapped: Telemetry disabled - no interval needed
	// private readonly intervalID: number
	constructor(
		// Air-gapped: Telemetry disabled - metrics service not used
		// @ts-ignore - intentionally unused
		@IMetricsService private readonly _metricsService: IMetricsService,
	) {
		super()

		// Air-gapped: Telemetry disabled - no periodic pings
		// const { window } = dom.getActiveWindow()
		// let i = 1
		// this.intervalID = window.setInterval(() => {
		// 	this.metricsService.capture('Alive', { iv1: i })
		// 	i += 1
		// }, PING_EVERY_MS)
	}

	override dispose() {
		super.dispose()
		// Air-gapped: No interval to clear since telemetry is disabled
	}


}

registerWorkbenchContribution2(MetricsPollService.ID, MetricsPollService, WorkbenchPhase.BlockRestore);
