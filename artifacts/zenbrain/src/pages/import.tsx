import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ArrowLeft, UploadCloud, FileType, CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "@/lib/supabase";

export default function ImportPage() {
  const { provider, profileId } = useParams<{ provider: string, profileId: string }>();
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    
    try {
      const formData = new FormData();
      formData.append('profileId', profileId!);
      formData.append('provider', provider!);
      formData.append('file', file);
      
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token}` },
        body: formData
      });
      
      if (!response.ok) throw new Error("Import failed");
      const data = await response.json();
      setReport(data);
    } catch (err: any) {
      setError(err.message || "Failed to upload file");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => setLocation(`/provider/${provider}/profile/${profileId}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Import Data</h1>
          <p className="text-muted-foreground">Upload your {provider} data export zip file</p>
        </div>
      </div>

      {!report ? (
        <Card>
          <CardContent className="p-8">
            <div className="border-2 border-dashed border-border rounded-xl p-12 text-center space-y-4">
              <div className="mx-auto w-16 h-16 bg-primary/10 text-primary rounded-full flex items-center justify-center">
                <UploadCloud className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-medium">Select your export file</h3>
                <p className="text-sm text-muted-foreground mt-1">Accepts .zip files from {provider} data exports.</p>
              </div>
              <input 
                type="file" 
                accept=".json,.zip" 
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full max-w-xs mx-auto text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20"
              />
            </div>
            
            {error && (
              <div className="mt-4 p-4 bg-destructive/10 text-destructive rounded-lg flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" /> {error}
              </div>
            )}

            <div className="mt-8 flex justify-end">
              <Button onClick={handleUpload} disabled={!file || uploading} size="lg">
                {uploading ? "Importing..." : "Start Import"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-green-500/20 bg-green-500/5">
          <CardHeader>
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-8 h-8 text-green-500" />
              <div>
                <CardTitle>Import Complete</CardTitle>
                <CardDescription>Your data has been successfully processed.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-background rounded-lg border">
                <div className="text-sm text-muted-foreground">New</div>
                <div className="text-xl font-medium">{report.new_count || 0}</div>
              </div>
              <div className="p-4 bg-background rounded-lg border">
                <div className="text-sm text-muted-foreground">Updated</div>
                <div className="text-xl font-medium">{report.updated_count || 0}</div>
              </div>
              <div className="p-4 bg-background rounded-lg border">
                <div className="text-sm text-muted-foreground">Skipped</div>
                <div className="text-xl font-medium">{report.skipped_count || 0}</div>
              </div>
              <div className="p-4 bg-background rounded-lg border">
                <div className="text-sm text-muted-foreground">Failed</div>
                <div className="text-xl font-medium text-destructive">{report.failed_count || 0}</div>
              </div>
            </div>
            <div className="flex justify-end mt-6">
              <Button onClick={() => setLocation(`/provider/${provider}/profile/${profileId}`)}>
                Back to Profile
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
