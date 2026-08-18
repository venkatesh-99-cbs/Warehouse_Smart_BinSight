# WarehouseOS

### AI-Powered Smart Warehouse Management & Decision Support Platform

**WarehouseOS** is an AI-powered warehouse management and decision-support platform designed to help warehouse managers understand operational problems, monitor critical activities, explore possible scenarios, and make faster data-driven decisions.

Built as a **solo project for the Prompt Wars X Work Wizards Innovations Hackathon 2026**, WarehouseOS focuses on transforming warehouse data into actionable operational insights.

## 🚀 Live Demo

[WarehouseOS — Live Demo](https://smartwarehousesight.freebuff.app/?utm_source=chatgpt.com)

---

## 📌 Overview

Modern warehouse operations involve continuously changing inventory levels, incoming orders, fulfillment delays, stock risks, and operational bottlenecks.

WarehouseOS provides a centralized interface for understanding these operational conditions and exploring potential outcomes before making decisions.

The platform focuses on four key principles:

> **Understand → Analyze → Simulate → Decide**

Instead of only displaying warehouse information, WarehouseOS is designed to provide a decision-oriented experience where managers can identify issues, explore scenarios, and understand their potential impact.

---

## ✨ Key Features

### 📦 Inventory & Stock Monitoring

Track important inventory conditions and identify potential stock-related problems before they affect fulfillment.

### 📋 Order & Fulfillment Visibility

Monitor pending orders, fulfillment activity, and operational delays from a centralized dashboard.

### ⚠️ Operational Issue Tracking

Identify and organize warehouse problems such as:

* Stock risks
* Order backlogs
* Fulfillment delays
* Picking issues
* Low inventory conditions
* Operational bottlenecks

### 🔮 What-If Simulation

Explore hypothetical operational changes and understand their possible impact before implementing them.

Examples include:

* Increasing available staff
* Changing operational capacity
* Evaluating potential backlog reduction
* Understanding fulfillment improvements
* Comparing possible operational outcomes

### 📊 Analytics Dashboard

Get a centralized overview of warehouse activity through visual metrics, issue breakdowns, and operational indicators.

### 📝 Recent Activity Logs

Review recent system activity and operational events to maintain better visibility into what is happening across the warehouse.

### 🔐 Authentication

WarehouseOS uses **Convex Auth** with support for email OTP and anonymous users. Authentication and protected routes are already integrated into the application.

### 📱 Responsive Interface

The application is designed to work across desktop and mobile screen sizes with responsive layouts and reusable UI components.

### 🎨 Interactive Experience

The interface uses animations and interactive components powered by **Framer Motion**, with **Three.js** available for 3D visual experiences.

---

## 🖥️ Platform Experience

WarehouseOS is organized around a dashboard-driven workflow.

### Dashboard

Provides a high-level operational overview including:

* Open warehouse issues
* Pending orders
* Inventory risks
* Operational status
* Issue categories
* Recent activities
* Simulation insights

### Issues

Provides visibility into active warehouse problems and operational risks.

### What-If Simulation

Allows users to explore hypothetical changes and evaluate potential operational outcomes.

### Analytics

Helps users understand warehouse activity and operational trends through visual data.

### Logs

Provides access to recent activity and system events for improved operational visibility.

### Reports

Provides a structured view of warehouse insights and operational information.

---

## 🧠 What Makes WarehouseOS Different?

Traditional warehouse dashboards primarily focus on **displaying information**.

WarehouseOS focuses on helping users **make decisions from that information**.

### Traditional Dashboard

```text
Data
 ↓
Charts
 ↓
Manual Analysis
 ↓
Decision
```

### WarehouseOS

```text
Warehouse Data
      ↓
Identify Issues
      ↓
Analyze Impact
      ↓
What-If Simulation
      ↓
Better Decision
```

This decision-support approach is the core concept behind WarehouseOS.

---

## 🛠️ Technology Stack

WarehouseOS is built using a modern full-stack web architecture.

| Technology          | Purpose                       |
| ------------------- | ----------------------------- |
| **React 19**        | Frontend application          |
| **TypeScript**      | Type-safe development         |
| **Vite**            | Frontend build tooling        |
| **React Router v7** | Application routing           |
| **Tailwind CSS v4** | Styling and responsive design |
| **Shadcn UI**       | Reusable interface components |
| **Lucide Icons**    | Interface icons               |
| **Convex**          | Backend and database          |
| **Convex Auth**     | Authentication                |
| **Framer Motion**   | UI animations                 |
| **Three.js**        | 3D graphics and experiences   |

The project uses **Bun** as its package manager.

---

## 🏗️ Architecture

```text
                    ┌──────────────────────┐
                    │      WarehouseOS     │
                    │      Web Client      │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     React 19 + Vite  │
                    │     TypeScript       │
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
        Dashboard         Simulation          Analytics
             │                 │                 │
             └─────────────────┼─────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │       Convex         │
                    │ Backend + Database    │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Convex Auth       │
                    │ Authentication       │
                    └──────────────────────┘
```

---

## 📂 Project Structure

The main application code is organized inside the `src` directory.

```text
WarehouseOS/
│
├── src/
│   ├── components/
│   │   ├── ui/
│   │   └── ...
│   │
│   ├── pages/
│   │   ├── Auth.tsx
│   │   └── ...
│   │
│   ├── convex/
│   │   ├── auth/
│   │   ├── schema.ts
│   │   └── ...
│   │
│   ├── hooks/
│   ├── main.tsx
│   └── index.css
│
├── public/
├── package.json
└── README.md
```

---

## 🔐 Authentication & Security

WarehouseOS uses **Convex Auth** for authentication.

The current authentication setup supports:

* Email OTP authentication
* Anonymous users
* Protected application routes
* Authenticated user state
* Backend authorization checks

The application uses a dedicated `/auth` route for authentication flows, while protected routes can redirect unauthenticated users to authentication before continuing to the requested page.

---

## ⚙️ Environment Configuration

WarehouseOS uses environment variables for its Convex deployment and authentication configuration.

### Client-side variables

```env
CONVEX_DEPLOYMENT=
VITE_CONVEX_URL=
```

### Convex backend variables

```env
JWKS=
JWT_PRIVATE_KEY=
SITE_URL=
```

The project already contains separate client-side and Convex backend environment configurations.

> **Important:** Never commit production secrets, private keys, authentication credentials, or environment files containing sensitive values to a public repository.

---

## 🚀 Getting Started

### Prerequisites

Make sure you have:

* Node.js
* Bun
* A Convex project
* Required environment variables

### 1. Clone the repository

```bash
git clone <YOUR_REPOSITORY_URL>
cd WarehouseOS
```

### 2. Install dependencies

```bash
bun install
```

### 3. Configure environment variables

Create the required environment configuration and provide your Convex deployment values.

```env
CONVEX_DEPLOYMENT=your_deployment
VITE_CONVEX_URL=your_convex_url
```

Configure the required Convex authentication environment variables on the backend.

### 4. Start the development server

```bash
bun run dev
```

The application should then be available through the local development URL provided by Vite.

---

## 🧪 Development

WarehouseOS follows a component-based React architecture.

Recommended locations:

```text
src/pages       → Application pages
src/components  → Reusable components
src/components/ui → Shadcn UI primitives
src/convex      → Backend functionality
src/hooks       → Reusable React hooks
```

The project follows responsive design principles and uses reusable Shadcn components throughout the interface.

---

## 🎯 Hackathon Context

### Prompt Wars X Work Wizards Innovations Hackathon 2026

WarehouseOS was created as a **solo hackathon project** for:

**Prompt Wars X Work Wizards Innovations Hackathon 2026**

The hackathon focuses on building innovative AI-powered prototypes using modern **Vibe Coding** approaches to solve real-world problems.

WarehouseOS explores this approach in the warehouse-management domain by combining:

* AI-assisted development
* Modern web technologies
* Interactive dashboards
* Operational analytics
* What-If simulation
* Decision-support concepts

---

## 🌟 Project Vision

WarehouseOS aims to move warehouse management from:

**Reactive → Proactive**

Instead of waiting for operational problems to become serious, the platform is designed around the idea of identifying issues early and exploring possible solutions.

### Vision

> **Make warehouse operations more visible, predictable, and decision-driven.**

---

## 🔮 Future Improvements

Potential future enhancements include:

* AI-powered operational recommendations
* Predictive inventory forecasting
* Demand prediction
* Automated anomaly detection
* Advanced warehouse simulations
* Real-time IoT integration
* Barcode and QR scanning
* Workforce optimization
* Automated report generation
* Advanced role-based access control
* Integration with existing warehouse management systems

---

## 📈 Future AI Capabilities

A future version of WarehouseOS could introduce an intelligent warehouse assistant capable of answering questions such as:

```text
"Which orders are currently at risk?"

"Why is the fulfillment backlog increasing?"

"What happens if I increase warehouse staff by 20%?"

"Which products are likely to run out of stock?"

"What operational issue should I prioritize?"
```

The goal would be to turn WarehouseOS from a monitoring platform into a more comprehensive **AI-powered warehouse decision system**.

---

## 👨‍💻 Built By

**Venkatesh Tambabathula**

Cybersecurity & Software Development Student
AI • Full-Stack Development • Cybersecurity • Vibe Coding

Built as a **solo project** for the Prompt Wars X Work Wizards Innovations Hackathon 2026.

---

## 🙏 Acknowledgements

Special thanks to:

* **Work Wizards Innovations Pvt. Ltd.**
* **Hack2skill**
* **Google for Developers**

for organizing the **Prompt Wars X Work Wizards Innovations Hackathon 2026** and providing an opportunity to experiment with AI-powered development and real-world problem solving.

---

## 📄 License

This project is created for educational, experimental, and hackathon purposes.

Add your preferred license here if the repository is intended for public open-source distribution.

---

## ⭐ Support the Project

If you find WarehouseOS interesting:

* ⭐ Star the repository
* 🐛 Report issues
* 💡 Suggest improvements
* 🔀 Contribute ideas
* 📢 Share the project

**WarehouseOS — Understand. Simulate. Decide.**

[🚀 Try WarehouseOS Live](https://smartwarehousesight.freebuff.app/?utm_source=chatgpt.com)
