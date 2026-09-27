# Agentic Supply Chain Control Tower

This repository contains the complete, standalone prototype for the Agentic Supply Chain Control Tower, an intelligent CAP (Cloud Application Programming) application for SAP Hackfest.

## Architecture

This project is a monolithic CAP application leveraging ES Modules, completely self-contained for deployment to SAP Business Application Studio (BAS).

- **Backend:** SAP CAP (Node.js/ESM) utilizing `@cap-js/db-service` with V4 Query Builders (`cds.db.run`).
- **Database:** SQLite (Development) / SAP HANA Cloud (Production).
- **Frontend:** SAPUI5 (Fiori Elements) served statically from `app/control-tower`.
- **AI Integration:** Direct integration with Google Gemini via `srv/geminiModel.js`.

## Local Development

### Prerequisites
- Node.js v18+ (v20+ recommended)
- `npm install` to install dependencies.

### Environment Configuration
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_google_gemini_api_key_here
```

### Running the Application
```bash
npx cds-serve
# or
npm run start
```
The backend API and UI will be available at `http://localhost:4004`.

## Deployment to SAP BTP (Cloud Foundry & HANA)

This prototype is built natively for SAP Business Application Studio and SAP BTP deployment.

1. **Database Deployment:**
   To deploy the database schema to SAP HANA Cloud, configure the `mta.yaml` (MTA descriptor) to bind to an HDI container.
   ```bash
   cds build --production
   ```

2. **Environment Variables on Cloud Foundry:**
   Ensure the `GEMINI_API_KEY` is securely stored in your Cloud Foundry environment variables for the Node.js module:
   ```bash
   cf set-env supply-chain-srv GEMINI_API_KEY your_google_gemini_api_key_here
   cf restage supply-chain-srv
   ```
   
3. **MTA Build and Deploy:**
   Use the Cloud MTA Build Tool (`mbt`) to build the archive:
   ```bash
   mbt build
   cf deploy mta_archives/supply-chain-prototype_1.0.0.mtar
   ```

## Workflow Endpoints

The AI orchestrator processes supply chain disruptions through a 5-step autonomous/semi-autonomous workflow. All logic resides in `srv/service.js`, executing via HTTP POST requests:

1. `/analyzeDisruption`: Identifies the impact of a disruption via Gemini models.
2. `/generateRecoveryPlans`: Generates up to 5 alternative recovery scenarios.
3. `/selectRecoveryPlan`: Selects a plan for approval.
4. `/approveRecovery`: Human-in-the-loop approval.
5. `/startRecovery`: Commences plan execution and AI monitoring.

*No manual database modifications are required; all logic operates deterministically via the Agent Orchestrator (`srv/agentOrchestrator.js`).*
