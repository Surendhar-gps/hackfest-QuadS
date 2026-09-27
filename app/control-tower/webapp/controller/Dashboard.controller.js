sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator"
], function (Controller, Filter, FilterOperator) {
    "use strict";

    return Controller.extend(
        "hackfest.controltower.controller.Dashboard",
        {

            onInit: function () {
                this._oRouter = this.getOwnerComponent().getRouter();

                this._loadKPIs();
            },

            onRefresh: function () {
                const oModel = this.getOwnerComponent().getModel();

                if (oModel) {
                    oModel.refresh();
                }

                this._loadKPIs();
            },

            _loadKPIs: function () {
                const oModel = this.getOwnerComponent().getModel();

                if (!oModel) {
                    console.warn("OData model is not available yet.");

                    this._setDefaultKPIs();
                    return;
                }

                if (typeof oModel.bindContext !== "function") {
                    console.warn("Current model is not an OData V4 model.");

                    this._setDefaultKPIs();
                    return;
                }

                const oBinding = oModel.bindContext(
                    "/getDashboardKPIs(...)"
                );

                oBinding.requestObject()
                    .then(function (oResult) {

                        oResult = oResult || {};

                        this._updateKPI(
                            "kpiOpenDisruptions",
                            oResult.openDisruptions ?? 0
                        );

                        this._updateKPI(
                            "kpiAtRisk",
                            oResult.atRiskProduction ?? 0
                        );

                        this._updateKPI(
                            "kpiPendingApprovals",
                            oResult.pendingApprovals ?? 0
                        );

                        this._updateKPI(
                            "kpiActiveRecoveries",
                            oResult.activeRecoveries ?? 0
                        );

                    }.bind(this))
                    .catch(function (error) {

                        console.warn(
                            "Dashboard KPI action is unavailable:",
                            error.message
                        );

                        this._setDefaultKPIs();

                    }.bind(this));
            },

            _setDefaultKPIs: function () {
                this._updateKPI("kpiOpenDisruptions", "?");
                this._updateKPI("kpiAtRisk", "?");
                this._updateKPI("kpiPendingApprovals", "?");
                this._updateKPI("kpiActiveRecoveries", "?");
            },

            _updateKPI: function (sId, value) {
                const oControl = this.byId(sId);

                if (oControl) {
                    oControl.setText(String(value));
                }
            },

            onDisruptionPress: function (oEvent) {
                const oContext =
                    oEvent.getSource().getBindingContext();

                if (!oContext) {
                    return;
                }

                const sId = oContext.getProperty("ID");

                this._oRouter.navTo(
                    "DisruptionDetail",
                    {
                        disruptionId: encodeURIComponent(sId)
                    }
                );
            },

            onInvestigatePress: function (oEvent) {
                const oContext =
                    oEvent.getSource().getBindingContext();

                if (!oContext) {
                    return;
                }

                const sId = oContext.getProperty("ID");

                this._oRouter.navTo(
                    "DisruptionDetail",
                    {
                        disruptionId: encodeURIComponent(sId)
                    }
                );
            },

            onSearch: function (oEvent) {
                const sQuery =
                    oEvent.getParameter("newValue") || "";

                const oTable =
                    this.byId("disruptionsTable");

                if (!oTable) {
                    return;
                }

                const oBinding =
                    oTable.getBinding("items");

                if (!oBinding) {
                    return;
                }

                const aFilters = [];

                if (sQuery) {

                    aFilters.push(
                        new Filter({
                            filters: [

                                new Filter(
                                    "type",
                                    FilterOperator.Contains,
                                    sQuery
                                ),

                                new Filter(
                                    "severity",
                                    FilterOperator.Contains,
                                    sQuery
                                ),

                                new Filter(
                                    "status",
                                    FilterOperator.Contains,
                                    sQuery
                                ),

                                new Filter(
                                    "description",
                                    FilterOperator.Contains,
                                    sQuery
                                )

                            ],
                            and: false
                        })
                    );
                }

                oBinding.filter(aFilters);
            }

        }
    );
});