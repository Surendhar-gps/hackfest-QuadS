sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"hackfest/controltower/test/integration/pages/SuppliersList.gen",
	"hackfest/controltower/test/integration/pages/SuppliersObjectPage.gen"
], function (JourneyRunner, SuppliersListGenerated, SuppliersObjectPageGenerated) {
    'use strict';

    const runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('hackfest/controltower') + '/test/flp.html#app-preview',
        pages: {
			onTheSuppliersListGenerated: SuppliersListGenerated,
			onTheSuppliersObjectPageGenerated: SuppliersObjectPageGenerated
        },
        async: true
    });

    return runner;
});

