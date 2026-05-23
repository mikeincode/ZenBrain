import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";

import { Layout } from "@/components/layout";
import AuthPage from "@/pages/auth";
import HomePage from "@/pages/home";
import ProviderPage from "@/pages/provider";
import ProfilePage from "@/pages/profile";
import ConversationPage from "@/pages/conversation";
import ImportPage from "@/pages/import";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: any }) {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (!session) return <AuthPage />;
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function Router() {
  const { session } = useAuth();

  useEffect(() => {
    // Inject auth token globally for custom-fetch
    if (session?.access_token) {
      (window as any).__supabaseToken = session.access_token;
    } else {
      (window as any).__supabaseToken = null;
    }
  }, [session]);

  return (
    <Switch>
      <Route path="/" component={() => <ProtectedRoute component={HomePage} />} />
      <Route path="/auth" component={AuthPage} />
      <Route path="/provider/:provider" component={() => <ProtectedRoute component={ProviderPage} />} />
      <Route path="/provider/:provider/profile/:profileId" component={() => <ProtectedRoute component={ProfilePage} />} />
      <Route path="/provider/:provider/profile/:profileId/conversation/:conversationId" component={() => <ProtectedRoute component={ConversationPage} />} />
      <Route path="/import/:provider/:profileId" component={() => <ProtectedRoute component={ImportPage} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
