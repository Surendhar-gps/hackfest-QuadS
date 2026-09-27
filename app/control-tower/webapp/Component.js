
sap.ui.define(
    [
        "sap/ui/core/UIComponent",
        "sap/ui/model/json/JSONModel"
    ],
    function (UIComponent, JSONModel) {
        "use strict";

        return UIComponent.extend("hackfest.controltower.Component", {

            metadata: {
                manifest: "json"
            },

            init: function () {
                UIComponent.prototype.init.apply(this, arguments);

                // Application state model
                const oAppModel = new JSONModel({
                    busy: false,
                    delay: 0,
                    selectedDisruptionId: null,
                    selectedPlanId: null
                });

                this.setModel(oAppModel, "app");

                this.getRouter().initialize();
            }
        });
    }
);

