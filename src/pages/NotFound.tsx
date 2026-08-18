import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="grid-bg flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center text-foreground"
    >
      <div className="accent-bar fixed inset-x-0 top-0" />
      <p className="mono text-7xl font-bold text-swissred">404</p>
      <p className="micro-label mt-6">Page not found</p>
      <h1 className="mt-3 max-w-md text-2xl font-bold tracking-tight">
        This route isn't on the warehouse map.
      </h1>
      <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
        The control deck has six stations — Overview, Inventory, Orders,
        Operations, Crisis, and Simulator.
      </p>
      <Button asChild className="mt-8">
        <Link to="/dashboard">Back to the control room</Link>
      </Button>
    </motion.div>
  );
}
