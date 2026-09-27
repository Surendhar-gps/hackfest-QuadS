sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/BusyIndicator"
], function (Controller, JSONModel, MessageBox, MessageToast, BusyIndicator) {
    "use strict";

    return Controller.extend("hackfest.controltower.controller.DisruptionDetail", {

        // ── Lifecycle ───────────────────────────────────────────────────────

        onInit: function () {
            this._oRouter = this.getOwnerComponent().getRouter();
            this._oRouter.getRoute("DisruptionDetail").attachPatternMatched(this._onRouteMatched, this);

            // Local JSON models
            this._oImpactModel   = new JSONModel({});
            this._oRecoveryModel = new JSONModel({ plans: [] });
            this._oRoutingModel  = new JSONModel({ routes: [] });
            this._oCostRiskModel = new JSONModel({ riskFactors: [] });
            this._oAuditModel    = new JSONModel({ logs: [] });

            this.getView().setModel(this._oImpactModel,   "impact");
            this.getView().setModel(this._oRecoveryModel, "recovery");
            this.getView().setModel(this._oRoutingModel,  "routing");
            this.getView().setModel(this._oCostRiskModel, "costRisk");
            this.getView().setModel(this._oAuditModel,    "audit");

            this._sDisruptionId     = null;
            this._sSelectedPlanId   = null;
            this._sMonitoringId     = null;
        },

        _onRouteMatched: function (oEvent) {
            const sId = decodeURIComponent(oEvent.getParameter("arguments").disruptionId);
            this._sDisruptionId   = sId;
            this._sSelectedPlanId = null;
            this._sMonitoringId   = null;

            this._resetSections();
            this._loadDisruption(sId);
            this._loadAuditLogs(sId);
            this._checkExistingPlans(sId);
        },

        // ── Navigation ──────────────────────────────────────────────────────

        onNavBack: function () {
            this._oRouter.navTo("Dashboard");
        },

        onRefreshDetail: function () {
            if (this._sDisruptionId) {
                this._loadDisruption(this._sDisruptionId);
                this._loadAuditLogs(this._sDisruptionId);
                this._checkExistingPlans(this._sDisruptionId);
            }
        },

        // ── Load disruption data ────────────────────────────────────────────

        _loadDisruption: function (sId) {
            const oModel = this.getView().getModel();
            const sPath  = `/Disruptions(${sId})`;

            oModel.bindContext(sPath, null, {
                $expand: "supplier,material,affectedPlant"
            }).requestObject().then(oData => {
                this._oDisruption = oData;
                this._populateHeader(oData);
                this._populateOverview(oData);

                // Restore persisted analysis if available
                if (oData.impactResult) {
                    try {
                        const oImpact = JSON.parse(oData.impactResult);
                        this._showImpactResults(oImpact);
                    } catch (_) {}
                }
                if (oData.aiExplanation) {
                    try {
                        const oAI = JSON.parse(oData.aiExplanation);
                        this._showAIResults(oAI);
                    } catch (_) {}
                }
            }).catch(e => {
                this._showMsg("overviewMsg", `Failed to load disruption: ${e.message}`, "Error");
            });
        },

        _populateHeader: function (d) {
            this.byId("detailTitle").setText(`Disruption: ${d.type} — ${d.description?.substring(0, 60)}...`);
            this.byId("detailTitleSnapped").setText(`${d.type} Disruption`);

            this._setObjStatus("headerSeverity", d.severity, this._severityState(d.severity));
            this._setObjStatus("headerStatus",   d.status,   this._statusState(d.status));

            this.byId("hdrType").setText(d.type || "");
            this.byId("hdrSupplier").setText(d.supplier?.name || "—");
            this.byId("hdrMaterial").setText(d.material?.materialName || "—");
            this.byId("hdrPlant").setText(d.affectedPlant?.name || "—");
            this.byId("hdrDelay").setNumber(d.estimatedDelayDays || 0);

            if (d.detectedAt) {
                const dt = new Date(d.detectedAt);
                this.byId("hdrDetected").setText(dt.toLocaleString());
            }
        },

        _populateOverview: function (d) {
            this.byId("ovDescription").setText(d.description || "—");
            this._setObjStatus("ovType",     d.type,     "None");
            this._setObjStatus("ovSeverity", d.severity, this._severityState(d.severity));
            this.byId("ovDelay").setNumber(d.estimatedDelayDays || 0);
            this.byId("ovSupplier").setText(d.supplier?.name || "—");
            this._setObjStatus("ovSupplierRisk", d.supplier?.riskStatus || "—",
                this._riskState(d.supplier?.riskStatus));
            this.byId("ovMaterial").setText(
                `${d.material?.materialCode} — ${d.material?.materialName}` || "—");
            this.byId("ovPlant").setText(d.affectedPlant?.name || "—");
            this._setObjStatus("ovStatus", d.status, this._statusState(d.status));
            if (d.detectedAt) this.byId("ovDetected").setText(new Date(d.detectedAt).toLocaleString());
        },

        // ── Impact Analysis ─────────────────────────────────────────────────

        onAnalyzeDisruption: function () {
            if (!this._sDisruptionId) return;
            BusyIndicator.show(0);
            this._showMsg("impactMsg", "Running disruption analysis...", "Information");

            this._callAction("analyzeDisruption", { disruptionId: this._sDisruptionId })
                .then(oResult => {
                    BusyIndicator.hide();
                    if (oResult.success) {
                        this._showImpactResults(oResult.data.impact);
                        this._showMsg("impactMsg", "Impact analysis complete.", "Success");
                        this._loadAuditLogs(this._sDisruptionId);
                    } else {
                        this._showMsg("impactMsg", `Analysis failed: ${oResult.error}`, "Error");
                    }
                })
                .catch(e => {
                    BusyIndicator.hide();
                    this._showMsg("impactMsg", `Error: ${e.message}`, "Error");
                });
        },

        _showImpactResults: function (oImpact) {
            if (!oImpact) return;

            this.byId("impCurrentInv").setNumber(oImpact.currentInventory || 0);
            this.byId("impShortage").setNumber(oImpact.shortageQuantity || 0);
            this.byId("impDaysStock").setNumber(oImpact.daysOfStock || 0);

            const bStockout = oImpact.stockoutDuringDisruption;
            const oStkCtrl = this.byId("impStockout");
            oStkCtrl.setText(bStockout ? "YES — Stockout Expected" : "No stockout");
            oStkCtrl.setState(bStockout ? "Error" : "Success");

            this.byId("impOrdersAtRisk").setNumber(oImpact.productionRisk?.ordersAtRisk || oImpact.affectedProductionOrders || 0);
            this.byId("impQtyAtRisk").setNumber(oImpact.productionQuantityAtRisk || 0);

            this.byId("impDailyConsumption").setNumber(oImpact.dailyConsumption || 0);
            this.byId("impRequiredQty").setNumber(oImpact.requiredQuantity || 0);
            this.byId("impStockoutDate").setText(oImpact.estimatedStockoutDate || "N/A");
            this.byId("impFinancial").setNumber(oImpact.financialEstimate || 0);

            const sProdRisk = oImpact.productionRisk?.riskLevel || "—";
            this._setObjStatus("impProdRisk", sProdRisk, this._riskState(sProdRisk));

            const bBelowReorder = oImpact.belowReorder;
            const oReorderCtrl = this.byId("impBelowReorder");
            oReorderCtrl.setText(bBelowReorder ? "Yes — Below reorder level" : "No");
            oReorderCtrl.setState(bBelowReorder ? "Error" : "Success");

            this.byId("impactKpiRow").setVisible(true);
            this.byId("impactDetails").setVisible(true);
            this.byId("impactEmptyText").setVisible(false);
        },

        // ── Recovery Plans ──────────────────────────────────────────────────

        onGenerateRecovery: function () {
            if (!this._sDisruptionId) return;
            BusyIndicator.show(0);
            this._showMsg("recoveryMsg", "Generating recovery plans...", "Information");

            this._callAction("generateRecoveryPlans", { disruptionId: this._sDisruptionId })
                .then(oResult => {
                    BusyIndicator.hide();
                    if (oResult.success) {
                        this._loadAndShowPlans(this._sDisruptionId);
                        const n = oResult.data?.plans?.filter(p => p.feasible).length || 0;
                        this._showMsg("recoveryMsg", `${n} feasible recovery option(s) generated.`, "Success");
                        this._loadAuditLogs(this._sDisruptionId);
                    } else {
                        this._showMsg("recoveryMsg", `Recovery generation failed: ${oResult.error}`, "Error");
                    }
                })
                .catch(e => {
                    BusyIndicator.hide();
                    this._showMsg("recoveryMsg", `Error: ${e.message}`, "Error");
                });
        },

        _checkExistingPlans: function (sId) {
            const oModel = this.getView().getModel();
            oModel.bindList(`/Disruptions(${sId})/RecoveryPlans`).requestContexts(0, 20)
                .then(aCtx => {
                    if (aCtx.length > 0) this._loadAndShowPlans(sId);
                })
                .catch(() => {});
        },

        _loadAndShowPlans: function (sId) {
            const oModel = this.getView().getModel();
            oModel.bindList("/RecoveryPlans", null, null, null, {
                $filter: `disruption_ID eq ${sId}`,
                $expand: "sourcePlant,destinationPlant,alternateSupplier($expand=supplier)"
            }).requestContexts(0, 20).then(aCtx => {
                const aPlans = aCtx.map(c => {
                    const o = c.getObject();
                    return {
                        ID:                   o.ID,
                        planType:             o.planType,
                        status:               o.status,
                        feasibility:          o.feasibility,
                        recoveryQuantity:     o.recoveryQuantity,
                        estimatedCost:        o.estimatedCost,
                        estimatedRecoveryDays: o.estimatedRecoveryDays,
                        transitDays:          o.transitDays,
                        riskLevel:            o.riskLevel,
                        riskScore:            o.riskScore,
                        sourcePlantSafe:      o.sourcePlantSafe,
                        costBreakdown:        o.costBreakdown,
                        riskFactors:          o.riskFactors,
                        sourceName:           o.sourcePlant?.name || o.alternateSupplier?.supplier?.name || "—",
                        destName:             o.destinationPlant?.name || "—"
                    };
                });

                this._oRecoveryModel.setData({ plans: aPlans });
                this.byId("recoveryTable").setVisible(true);
                this.byId("recoveryEmptyText").setVisible(false);

                // Show cost/risk for best feasible plan
                const best = aPlans.find(p => p.feasibility === "Feasible" &&
                    (p.status === "Selected" || p.status === "Proposed"));
                if (best) this._showCostRisk(best);

                // Check if there's a selected plan for approval
                const selected = aPlans.find(p =>
                    ["Selected","PendingApproval","Approved","InProgress"].includes(p.status));
                if (selected) {
                    this._sSelectedPlanId = selected.ID;
                    this._showApprovalPanel(selected);
                    this._loadMonitoring(selected.ID);
                }
            }).catch(e => console.warn("Load plans failed:", e.message));
        },

        onSelectPlan: function (oEvent) {
            const oBtn = oEvent.getSource();
            const sRaw = oBtn.data("planId");
            // CustomData in XML binding
            const oCtx = oBtn.getParent().getBindingContext("recovery");
            const sPlanId = oCtx ? oCtx.getProperty("ID") : sRaw;

            if (!sPlanId) {
                MessageToast.show("Could not determine plan ID");
                return;
            }

            MessageBox.confirm("Select this recovery plan for manager approval?", {
                title: "Select Recovery Plan",
                onClose: sAction => {
                    if (sAction === MessageBox.Action.OK) {
                        BusyIndicator.show(0);
                        this._callAction("selectRecoveryPlan", { planId: sPlanId })
                            .then(oResult => {
                                BusyIndicator.hide();
                                if (oResult.success) {
                                    this._sSelectedPlanId = sPlanId;
                                    MessageToast.show("Plan selected. Proceed to Manager Approval section.");
                                    this._loadAndShowPlans(this._sDisruptionId);
                                    this._loadAuditLogs(this._sDisruptionId);
                                    // Find plan data and show approval
                                    const oPlans = this._oRecoveryModel.getProperty("/plans");
                                    const oPlan  = oPlans.find(p => p.ID === sPlanId);
                                    if (oPlan) this._showApprovalPanel(oPlan);
                                } else {
                                    this._showMsg("recoveryMsg", `Select failed: ${oResult.error}`, "Error");
                                }
                            })
                            .catch(e => { BusyIndicator.hide(); this._showMsg("recoveryMsg", e.message, "Error"); });
                    }
                }
            });
        },

        // ── Routing ─────────────────────────────────────────────────────────

        onAnalyzeRoutes: function () {
            if (!this._sDisruptionId) return;
            BusyIndicator.show(0);
            this._showMsg("routingMsg", "Analyzing routes...", "Information");

            this._callAction("analyzeRoutes", { disruptionId: this._sDisruptionId })
                .then(oResult => {
                    BusyIndicator.hide();
                    if (oResult.success && oResult.data) {
                        const aRoutes = [];
                        oResult.data.forEach(planRoutes => {
                            (planRoutes.routes || []).forEach(r => {
                                aRoutes.push({ planType: planRoutes.planType, ...r });
                            });
                        });
                        // Also load from OData directly
                        this._loadRoutesFromOData();
                        this._showMsg("routingMsg", `${aRoutes.length} route(s) analyzed.`, "Success");
                    } else {
                        this._showMsg("routingMsg", `Route analysis failed: ${oResult.error}`, "Error");
                    }
                })
                .catch(e => {
                    BusyIndicator.hide();
                    this._showMsg("routingMsg", e.message, "Error");
                });
        },

        _loadRoutesFromOData: function () {
            const oModel = this.getView().getModel();
            // Get all plans for this disruption, then load their routes
            oModel.bindList("/RoutingOptions", null, null, null, {
                $expand: "recoveryPlan($select=planType,disruption_ID,status)"
            }).requestContexts(0, 50).then(aCtx => {
                const aRoutes = aCtx
                    .map(c => c.getObject())
                    .filter(r => r.recoveryPlan?.disruption_ID === this._sDisruptionId);

                if (aRoutes.length > 0) {
                    const aFlat = aRoutes.map(r => ({
                        planType:            r.recoveryPlan?.planType || "—",
                        sourceLocation:      r.sourceLocation,
                        destinationLocation: r.destinationLocation,
                        distanceKm:          r.distanceKm,
                        transitDays:         r.transitDays,
                        estimatedArrival:    r.estimatedArrival,
                        transportMode:       r.transportMode,
                        transportCost:       r.transportCost,
                        routeRisk:           r.routeRisk,
                        routeStatus:         r.routeStatus
                    }));
                    this._oRoutingModel.setData({ routes: aFlat });
                    this.byId("routingTable").setVisible(true);
                    this.byId("routingEmptyText").setVisible(false);
                }
            }).catch(() => {});
        },

        // ── Cost & Risk ─────────────────────────────────────────────────────

        _showCostRisk: function (oPlan) {
            let oCostBreakdown = { material: 0, transport: 0, premium: 0, expedite: 0, transfer: 0 };
            let aRiskFactors   = [];

            try {
                if (oPlan.costBreakdown) oCostBreakdown = JSON.parse(oPlan.costBreakdown);
            } catch (_) {}
            try {
                if (oPlan.riskFactors) aRiskFactors = JSON.parse(oPlan.riskFactors);
            } catch (_) {}

            this.byId("crTotalCost").setNumber(oPlan.estimatedCost || 0);
            this.byId("crMaterial").setNumber(oCostBreakdown.material || 0);
            this.byId("crTransport").setNumber(oCostBreakdown.transport || 0);
            this.byId("crPremium").setNumber(oCostBreakdown.premium || 0);
            this.byId("crExpedite").setNumber(oCostBreakdown.expedite || 0);
            this.byId("crTransfer").setNumber(oCostBreakdown.transfer || 0);

            this._setObjStatus("crRiskLevel", oPlan.riskLevel, this._riskState(oPlan.riskLevel));
            this.byId("crRiskScore").setNumber(oPlan.riskScore || 0);

            // Load risk assessment from OData
            const oModel = this.getView().getModel();
            oModel.bindList("/RiskAssessments", null, null, null, {
                $filter: `recoveryPlan_ID eq ${oPlan.ID}`
            }).requestContexts(0, 1).then(aCtx => {
                if (aCtx.length > 0) {
                    const oRisk = aCtx[0].getObject();
                    this._setObjStatus("crInvRisk",     oRisk.inventoryRisk,    this._riskState(oRisk.inventoryRisk));
                    this._setObjStatus("crTransitRisk",  oRisk.transitRisk,      this._riskState(oRisk.transitRisk));
                    this._setObjStatus("crSrcSafe",
                        oPlan.sourcePlantSafe ? "Safe" : "At Risk",
                        oPlan.sourcePlantSafe ? "Success" : "Error");
                    try {
                        aRiskFactors = JSON.parse(oRisk.riskFactors || "[]");
                    } catch (_) {}
                }
            }).catch(() => {
                this._setObjStatus("crInvRisk",    "—", "None");
                this._setObjStatus("crTransitRisk", "—", "None");
                this._setObjStatus("crSrcSafe",
                    oPlan.sourcePlantSafe ? "Safe" : "At Risk",
                    oPlan.sourcePlantSafe ? "Success" : "Error");
            }).finally(() => {
                this._oCostRiskModel.setData({ riskFactors: aRiskFactors });
                this.byId("costRiskContent").setVisible(true);
                this.byId("costRiskEmptyText").setVisible(false);
            });
        },

        // ── AI Explanation ──────────────────────────────────────────────────

        onGenerateAI: function () {
            if (!this._sDisruptionId) return;
            BusyIndicator.show(0);
            this._showMsg("aiMsg", "Calling Gemini AI — this may take a few seconds...", "Information");

            this._callAction("generateAIExplanation", { disruptionId: this._sDisruptionId })
                .then(oResult => {
                    BusyIndicator.hide();
                    if (oResult.success) {
                        this._showAIResults(oResult.data);
                        if (oResult.data.fallback) {
                            this._showMsg("aiMsg",
                                "AI explanation unavailable. Deterministic supply-chain analysis is still available.",
                                "Warning");
                        } else {
                            this._showMsg("aiMsg", "Gemini AI explanation generated successfully.", "Success");
                        }
                        this._loadAuditLogs(this._sDisruptionId);
                    } else {
                        this._showMsg("aiMsg", `AI generation failed: ${oResult.error}`, "Error");
                    }
                })
                .catch(e => {
                    BusyIndicator.hide();
                    this._showMsg("aiMsg", `Error: ${e.message}`, "Error");
                });
        },

        _showAIResults: function (oAI) {
            if (!oAI) return;

            this.byId("aiExecText").setText(oAI.executiveSummary || "—");
            this.byId("aiSituationText").setText(oAI.situation || "—");
            this.byId("aiImpactText").setText(oAI.impactExplanation || "—");
            this.byId("aiRecoveryText").setText(oAI.recoveryExplanation || "—");
            this.byId("aiCostText").setText(oAI.costExplanation || "—");
            this.byId("aiRiskText").setText(oAI.riskExplanation || "—");
            this.byId("aiTradeoffsText").setText(oAI.tradeoffs || "—");
            this.byId("aiNextActionText").setText(oAI.nextAction || "—");

            this._setObjStatus("aiConfidence", oAI.confidence || "—",
                oAI.confidence === "high" ? "Success" : oAI.confidence === "medium" ? "Warning" : "Error");
            this._setObjStatus("aiUrgency", oAI.urgency || "—",
                this._severityState(oAI.urgency));

            this.byId("aiContent").setVisible(true);
            this.byId("aiEmptyText").setVisible(false);
        },

        // ── Approval ────────────────────────────────────────────────────────

        _showApprovalPanel: function (oPlan) {
            this.byId("apPlanType").setText(oPlan.planType || "—");
            this.byId("apQuantity").setNumber(oPlan.recoveryQuantity || 0);
            this.byId("apCost").setNumber(oPlan.estimatedCost || 0);
            this.byId("apTime").setNumber(oPlan.estimatedRecoveryDays || 0);
            this._setObjStatus("apRisk", oPlan.riskLevel, this._riskState(oPlan.riskLevel));

            const bSafe = oPlan.sourcePlantSafe !== false;
            this.byId("apSrcSafe").setText(bSafe ? "Safe — Source plant remains operational" : "RISK — Safety threshold violated");
            this.byId("apSrcSafe").setState(bSafe ? "Success" : "Error");

            this.byId("approvalPanel").setVisible(true);
            this.byId("approvalEmptyText").setVisible(false);

            // Enable start/complete buttons based on plan status
            const bApproved   = oPlan.status === "Approved";
            const bInProgress = oPlan.status === "InProgress";
            this.byId("btnStartRecovery").setEnabled(bApproved);
            this.byId("btnCompleteRecovery").setEnabled(bInProgress);
        },

        onApproveRecovery: function () {
            if (!this._sSelectedPlanId) {
                MessageToast.show(this._i18n("msg.selectPlan"));
                return;
            }
            const sApprover  = this.byId("approverName").getValue();
            const sComments  = this.byId("approverComments").getValue();

            if (!sApprover.trim()) {
                MessageBox.warning("Please enter your name as approver.");
                return;
            }

            MessageBox.confirm("Approve this recovery plan and proceed with execution?", {
                title: "Approve Recovery",
                emphasizedAction: "Approve",
                actions: ["Approve", MessageBox.Action.CANCEL],
                onClose: sAction => {
                    if (sAction === "Approve") {
                        BusyIndicator.show(0);
                        this._callAction("approveRecovery", {
                            planId:   this._sSelectedPlanId,
                            approver: sApprover,
                            comments: sComments
                        }).then(oResult => {
                            BusyIndicator.hide();
                            if (oResult.success) {
                                MessageToast.show("Recovery approved successfully!");
                                this._showMsg("approvalMsg", "Recovery plan approved. Proceed to start execution.", "Success");
                                this._loadAndShowPlans(this._sDisruptionId);
                                this._loadAuditLogs(this._sDisruptionId);
                                this.byId("btnStartRecovery").setEnabled(true);
                            } else {
                                this._showMsg("approvalMsg", `Approval failed: ${oResult.error}`, "Error");
                            }
                        }).catch(e => {
                            BusyIndicator.hide();
                            this._showMsg("approvalMsg", e.message, "Error");
                        });
                    }
                }
            });
        },

        onRejectRecovery: function () {
            if (!this._sSelectedPlanId) {
                MessageToast.show(this._i18n("msg.selectPlan"));
                return;
            }
            const sApprover = this.byId("approverName").getValue();
            const sComments = this.byId("approverComments").getValue();

            MessageBox.confirm("Reject this recovery plan? The disruption will return to planning status.", {
                title: "Reject Recovery",
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                onClose: sAction => {
                    if (sAction === MessageBox.Action.OK) {
                        BusyIndicator.show(0);
                        this._callAction("rejectRecovery", {
                            planId:   this._sSelectedPlanId,
                            approver: sApprover || "Manager",
                            comments: sComments
                        }).then(oResult => {
                            BusyIndicator.hide();
                            if (oResult.success) {
                                MessageToast.show("Recovery plan rejected.");
                                this._showMsg("approvalMsg", "Plan rejected. Generate new recovery options if needed.", "Warning");
                                this._sSelectedPlanId = null;
                                this._loadAndShowPlans(this._sDisruptionId);
                                this._loadAuditLogs(this._sDisruptionId);
                            } else {
                                this._showMsg("approvalMsg", `Rejection failed: ${oResult.error}`, "Error");
                            }
                        }).catch(e => {
                            BusyIndicator.hide();
                            this._showMsg("approvalMsg", e.message, "Error");
                        });
                    }
                }
            });
        },

        // ── Monitoring ──────────────────────────────────────────────────────

        onStartRecovery: function () {
            if (!this._sSelectedPlanId) {
                MessageToast.show("No approved plan selected.");
                return;
            }
            BusyIndicator.show(0);
            this._callAction("startRecovery", { planId: this._sSelectedPlanId })
                .then(oResult => {
                    BusyIndicator.hide();
                    if (oResult.success) {
                        MessageToast.show("Recovery execution started!");
                        this._showMsg("monitoringMsg", "Recovery execution initiated. Monitor progress below.", "Success");
                        this._loadMonitoring(this._sSelectedPlanId);
                        this._loadAuditLogs(this._sDisruptionId);
                        this.byId("btnStartRecovery").setEnabled(false);
                        this.byId("btnCompleteRecovery").setEnabled(true);
                    } else {
                        this._showMsg("monitoringMsg", `Start failed: ${oResult.error}`, "Error");
                    }
                })
                .catch(e => {
                    BusyIndicator.hide();
                    this._showMsg("monitoringMsg", e.message, "Error");
                });
        },

        _loadMonitoring: function (sPlanId) {
            const oModel = this.getView().getModel();
            oModel.bindList("/RecoveryMonitoring", null, null, null, {
                $filter: `recoveryPlan_ID eq ${sPlanId}`
            }).requestContexts(0, 1).then(aCtx => {
                if (aCtx.length > 0) {
                    const o = aCtx[0].getObject();
                    this._sMonitoringId = o.ID;
                    this._showMonitoringPanel(o);
                }
            }).catch(() => {});
        },

        _showMonitoringPanel: function (o) {
            this._setObjStatus("monStatus", o.status, this._monitoringState(o.status));
            this.byId("monPlanned").setNumber(o.plannedQuantity || 0);
            this.byId("monRecovered").setNumber(o.recoveredQuantity || 0);

            const pct = Math.min(Math.round(
                o.plannedQuantity > 0 ? (o.recoveredQuantity / o.plannedQuantity) * 100 : 0
            ), 100);
            const oProg = this.byId("monProgress");
            oProg.setPercentValue(pct);
            oProg.setDisplayValue(`${pct}%`);
            oProg.setState(pct >= 100 ? "Success" : pct >= 50 ? "Warning" : "Error");

            if (o.expectedArrival) {
                this.byId("monETA").setText(new Date(o.expectedArrival).toLocaleString());
            }
            if (o.lastUpdated) {
                this.byId("monLastUpdated").setText(new Date(o.lastUpdated).toLocaleString());
            }

            this.byId("monitoringPanel").setVisible(true);
            this.byId("monitoringEmptyText").setVisible(false);
        },

        onUpdateMonitoring: function () {
            if (!this._sMonitoringId) {
                MessageToast.show("No active monitoring record. Start recovery first.");
                return;
            }
            const sStatus = this.byId("monNewStatus").getSelectedKey();
            const sQty    = this.byId("monUpdateQty").getValue();
            const sNotes  = this.byId("monNotes").getValue();
            const sBy     = this.byId("monUpdatedBy").getValue() || "User";

            if (!sQty) {
                MessageBox.warning("Please enter the recovered quantity.");
                return;
            }

            BusyIndicator.show(0);
            this._callAction("updateRecoveryStatus", {
                monitoringId:      this._sMonitoringId,
                status:            sStatus,
                recoveredQuantity: parseFloat(sQty),
                notes:             sNotes,
                updatedBy:         sBy
            }).then(oResult => {
                BusyIndicator.hide();
                if (oResult.success) {
                    MessageToast.show("Recovery status updated.");
                    this._loadMonitoring(this._sSelectedPlanId);
                    this._loadAuditLogs(this._sDisruptionId);
                    this.byId("monUpdateQty").setValue("");
                    this.byId("monNotes").setValue("");
                } else {
                    this._showMsg("monitoringMsg", `Update failed: ${oResult.error}`, "Error");
                }
            }).catch(e => {
                BusyIndicator.hide();
                this._showMsg("monitoringMsg", e.message, "Error");
            });
        },

        onCompleteRecovery: function () {
            if (!this._sSelectedPlanId) return;
            MessageBox.confirm("Mark this recovery as fully completed?", {
                title: "Complete Recovery",
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                onClose: sAction => {
                    if (sAction === MessageBox.Action.OK) {
                        BusyIndicator.show(0);
                        this._callAction("completeRecovery", { planId: this._sSelectedPlanId })
                            .then(oResult => {
                                BusyIndicator.hide();
                                if (oResult.success) {
                                    MessageToast.show("Recovery completed successfully!");
                                    this._showMsg("monitoringMsg", "Recovery plan completed. Disruption resolved.", "Success");
                                    this._loadMonitoring(this._sSelectedPlanId);
                                    this._loadAuditLogs(this._sDisruptionId);
                                    this.byId("btnCompleteRecovery").setEnabled(false);
                                } else {
                                    this._showMsg("monitoringMsg", `Complete failed: ${oResult.error}`, "Error");
                                }
                            })
                            .catch(e => {
                                BusyIndicator.hide();
                                this._showMsg("monitoringMsg", e.message, "Error");
                            });
                    }
                }
            });
        },

        // ── Audit ────────────────────────────────────────────────────────────

        _loadAuditLogs: function (sDisruptionId) {
            const oModel = this.getView().getModel();
            oModel.bindList("/AuditLogs", null,
                [{ name: "timestamp", descending: true }], null, {
                $filter: `disruption_ID eq ${sDisruptionId}`
            }).requestContexts(0, 50).then(aCtx => {
                const aLogs = aCtx.map(c => {
                    const o = c.getObject();
                    let sFormatted = o.timestamp;
                    try {
                        const d = new Date(o.timestamp);
                        sFormatted = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                    } catch (_) {}
                    return { ...o, timestampFormatted: sFormatted };
                });
                this._oAuditModel.setData({ logs: aLogs });
            }).catch(() => {});
        },

        // ── CAP Action helper ────────────────────────────────────────────────

        _callAction: function (sAction, oParams) {
            const oModel = this.getView().getModel();
            const oOp    = oModel.bindContext(`/${sAction}(...)`);
            oOp.setParameter("__skipCache", true);
            Object.entries(oParams).forEach(([k, v]) => oOp.setParameter(k, v));
            return oOp.execute().then(() => {
                const raw = oOp.getBoundContext().getObject()?.value || oOp.getBoundContext().getObject();
                if (typeof raw === "string") {
                    return JSON.parse(raw);
                }
                return raw;
            });
        },

        // ── UI helpers ───────────────────────────────────────────────────────

        _setObjStatus: function (sId, sText, sState) {
            const o = this.byId(sId);
            if (o) { o.setText(sText || "—"); o.setState(sState || "None"); }
        },

        _showMsg: function (sId, sText, sType) {
            const o = this.byId(sId);
            if (!o) return;
            o.setText(sText);
            o.setType(sType || "Information");
            o.setVisible(true);
        },

        _i18n: function (sKey) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey);
        },

        _severityState: function (s) {
            return s === "Critical" ? "Error" : s === "High" ? "Warning" :
                   s === "Medium"   ? "Warning" : s === "Low" ? "Success" : "None";
        },

        _statusState: function (s) {
            const map = {
                Resolved: "Success", Approved: "Success", Completed: "Success",
                Detected: "Error", Rejected: "Error",
                InProgress: "Warning", PendingApproval: "Warning",
                RecoveryPlanned: "Information", Analyzed: "Information"
            };
            return map[s] || "None";
        },

        _riskState: function (s) {
            return s === "Critical" ? "Error" : s === "High" ? "Warning" :
                   s === "Medium"   ? "Warning" : s === "Low" ? "Success" : "None";
        },

        _monitoringState: function (s) {
            const map = { Completed: "Success", Delivered: "Success",
                InTransit: "Warning", Delayed: "Error", Initiated: "Information" };
            return map[s] || "None";
        },

        _resetSections: function () {
            // Reset all sections to empty state
            ["impactKpiRow","impactDetails"].forEach(id => {
                const c = this.byId(id); if (c) c.setVisible(false);
            });
            const impEmpty = this.byId("impactEmptyText"); if (impEmpty) impEmpty.setVisible(true);
            const recTable = this.byId("recoveryTable"); if (recTable) recTable.setVisible(false);
            const recEmpty = this.byId("recoveryEmptyText"); if (recEmpty) recEmpty.setVisible(true);
            const routTable = this.byId("routingTable"); if (routTable) routTable.setVisible(false);
            const routEmpty = this.byId("routingEmptyText"); if (routEmpty) routEmpty.setVisible(true);
            const crContent = this.byId("costRiskContent"); if (crContent) crContent.setVisible(false);
            const crEmpty = this.byId("costRiskEmptyText"); if (crEmpty) crEmpty.setVisible(true);
            const aiContent = this.byId("aiContent"); if (aiContent) aiContent.setVisible(false);
            const aiEmpty = this.byId("aiEmptyText"); if (aiEmpty) aiEmpty.setVisible(true);
            const apPanel = this.byId("approvalPanel"); if (apPanel) apPanel.setVisible(false);
            const apEmpty = this.byId("approvalEmptyText"); if (apEmpty) apEmpty.setVisible(true);
            const monPanel = this.byId("monitoringPanel"); if (monPanel) monPanel.setVisible(false);
            const monEmpty = this.byId("monitoringEmptyText"); if (monEmpty) monEmpty.setVisible(true);
            ["impactMsg","recoveryMsg","routingMsg","aiMsg","approvalMsg","monitoringMsg"].forEach(id => {
                const c = this.byId(id); if (c) c.setVisible(false);
            });
            this._oRecoveryModel.setData({ plans: [] });
            this._oRoutingModel.setData({ routes: [] });
            this._oCostRiskModel.setData({ riskFactors: [] });
        }
    });
});
