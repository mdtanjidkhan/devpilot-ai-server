const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
const port = process.env.PORT;
const uri = process.env.MONGODB_URI;
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  try {
    await client.connect();
    
    const db = client.db("devpilot");
    const projectsCollection = db.collection("projects");
    const aiGenerationsCollection = db.collection("ai_generations");
    // const paymentsCollection = db.collection("payments");
    const profilesCollection = db.collection("profiles");
    await profilesCollection.createIndex({ userId: 1 }, { unique: true });
    console.log("  Successfully connected to MongoDB and initialized collections!");

  app.post('/api/generate-blueprint', async (req, res) => {
  try {
    const { projectName, category, description, targetUsers, selectedTech, userId } = req.body;

    if (!projectName || !category || !description || !targetUsers || !userId) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }
    const currentProjectCount = await projectsCollection.countDocuments({ userId: userId });
    
    if (currentProjectCount >= 5) {
      return res.status(403).json({ 
        success: false, 
        error: "You have reached your free limit of 5 projects. Please upgrade to Premium!" 
      });
    }
   
    const prompt = `
      You are an expert Software Architect. Analyze the following project requirements and generate a detailed production-ready software blueprint.
      
      Project Details:
      - Name: ${projectName}
      - Category: ${category}
      - Description: ${description}
      - Target Users: ${targetUsers}
      - Preferred Tech Stack: ${selectedTech ? selectedTech.join(', ') : 'Not specified'}

      CRITICAL JSON STRUCTURE REQUIREMENT: 
      You must return a raw JSON object matching the schema below. 
      Do NOT wrap the JSON inside markdown blocks like \`\`\`json or \`\`\`.
      Inside the "fileStructure" and "schemaDesign" fields, provide the code or layout directly as plain text string without using any markdown code blocks (\`\`\`).

      Expected JSON Schema:
      {
        "overview": "Detailed architectural overview...",
        "modules": [
          "Module 1 description",
          "Module 2 description"
        ],
        "fileStructure": "Plain text directory tree representation here (NO markdown blocks)",
        "schemaDesign": "Plain text database schema layout or code here (NO markdown blocks)"
      }
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const aiResponseText = response.text.trim();
    
    let blueprintData;
    try {
      blueprintData = JSON.parse(aiResponseText);
    } catch (jsonErr) {
      console.error("Failed to parse AI response as JSON:", aiResponseText);
      return res.status(500).json({ success: false, error: "AI response formatting error. Please try again." });
    }

    const newProject = {
      userId,
      projectName,
      category,
      description,
      targetUsers,
      selectedTech: selectedTech || [],
      blueprint: blueprintData,
      createdAt: new Date()
    };

    const result = await projectsCollection.insertOne(newProject);
    console.log("Project blueprint saved with ID:", result.insertedId);

    const newNotification = {
      userId: userId, 
      title: "Blueprint Generated",
      message: `Your project "${projectName}" architectural blueprint is ready!`,
      isRead: false,
      createdAt: new Date()
    };
    await db.collection("notifications").insertOne(newNotification);
    
    res.status(201).json({
      success: true,
      message: "Project blueprint generated and saved successfully",
      projectId: result.insertedId
    });

  } catch (error) {
    console.error("Error in /api/generate-blueprint:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 
app.get('/api/projects/count', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ success: false, error: "Missing userId parameter" });
    }
    const count = await projectsCollection.countDocuments({ userId: userId });

    return res.status(200).json({
      success: true,
      count: count
    });
  } catch (error) {
    console.error("Error fetching project count:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


  app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }

    const projects = await db.collection("projects")
      .find({ userId: userId })
      .sort({ createdAt: -1 }) 
      .toArray();

    const totalProjects = projects.length;
    const totalAiGenerations = await db.collection("ai_generations")
      .countDocuments({ userId: userId });

    const savedBlueprints = totalProjects; 
    let subscription = await db.collection("subscriptions").findOne({ userId: userId });
  
    if (!subscription) {
      subscription = {
        plan: "Free",
        tokenLimit: 50000,
        currentUsage: 0
      };
    }
    const chartDataRaw = await db.collection("ai_generations").aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          tokens: { $sum: "$tokensUsed" }, 
          blueprints: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } },
      { $limit: 7 } 
    ]).toArray();
    const chartData = chartDataRaw.map(item => ({
      name: item._id,
      tokens: item.tokens || 0,
      blueprints: item.blueprints || 0
    }));

    res.status(200).json({
      success: true,
      projects,
      subscription, 
      chartData,    
      stats: {
        totalProjects,
        totalAiGenerations,
        savedBlueprints
      }
    });

  } catch (error) {
    console.error("Dashboard backend error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

   app.get('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;
  
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, error: "Invalid Project ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const project = await projectsCollection.findOne(query);

        if (!project) {
          return res.status(404).json({ success: false, error: "Project not found" });
        }

        res.status(200).json({ success: true, project });
      } catch (error) {
        console.error("Error in fetching project:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

   // patch endpoint to update a specific section of the blueprint
app.patch('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const { section, value } = req.body; 
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid project ID format" });
        }
        const updateField = {};
        updateField[`blueprint.${section}`] = value;

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: updateField
        };

        const result = await projectsCollection.updateOne(filter, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).json({ success: false, message: "Project not found" });
        }

        res.json({ success: true, message: "Section updated successfully" });
      } catch (error) {
        console.error("Error updating project section:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
// delete endpoint to remove a project by ID
    app.delete('/api/projects/:id', async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid project ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await projectsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res.json({ success: true, message: "Project deleted successfully from database" });
        } else {
          res.status(404).json({ success: false, message: "Project not found" });
        }
      } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // dashboard/projects endpoint to fetch all projects with pagination
  app.get('/api/projects', async (req, res) => {
  try {
    const { search, userId } = req.query; 
    let query = {};
    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required to fetch projects" });
    }
    query.userId = userId;
    if (search) {
      query.$and = [
        { userId: userId }, 
        {
          $or: [
            { projectName: { $regex: search, $options: 'i' } }, 
            { category: { $regex: search, $options: 'i' } }
          ]
        }
      ];
    }

    const projects = await projectsCollection.find(query).sort({ _id: -1 }).toArray();
    res.json({ success: true, projects });

  } catch (error) {
    console.error("Error fetching projects with user filtering:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ai_generations endpoint to fetch all AI generations with pagination

app.post('/api/projects/:id/generations', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { prompt, generationType,user} = req.body;
    

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, error: "Prompt is required" });
    }

    const project = await projectsCollection.findOne({ _id: new ObjectId(projectId) });
    if (!project) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    let chosenModel = "gemini-2.5-flash"; 
    let temperature = 0.7;            
    
    if (user?.id) {
      const prefs = await db.collection("user_preferences").findOne({ userId: user.id });
      if (prefs && prefs.aiPreferences) {
        if (prefs.aiPreferences.defaultModel) {
          chosenModel = prefs.aiPreferences.defaultModel;
        }
        
        const creativity = prefs.aiPreferences.creativityLevel;
        if (creativity === "Low") temperature = 0.2;
        else if (creativity === "High") temperature = 1.2;
        else temperature = 0.7; 
      }
    }
    
    const geminiPrompt = `
      You are DevPilot Copilot, an expert AI software engineer. 
      You are helping the user build and expand a project.
      
      [PROJECT CONTEXT]
      Project Name: ${project.projectName}
      Category: ${project.category}
      Target Users/Scale: ${project.targetUsers}
      Tech Stack: ${project.selectedTech ? project.selectedTech.join(", ") : "Not specified"}
      
      [CURRENT BLUEPRINT]
      Overview: ${project.blueprint?.overview || "N/A"}
      Core Modules: ${project.blueprint?.modules ? project.blueprint.modules.join(", ") : "N/A"}
      Schema Layout: ${project.blueprint?.schemaDesign || "N/A"}
      
      [USER'S REQUEST]
      "${prompt}"
      
      Instructions: Respond to the user's request precisely. If they ask for code, route config, database queries, or module expansions, provide clean, robust, and industry-standard solutions that perfectly align with the configured tech stack. Keep explanations clear and concise.
    `;

    const response = await ai.models.generateContent({
     model: chosenModel, 
      contents: geminiPrompt,
      config: {
        temperature: temperature 
      }
    });

    const generatedOutput = response.text;
    const tokensUsed = response.usageMetadata?.totalTokenCount || 3000;
    const newGeneration = {
      projectId: new ObjectId(projectId), 
      projectName: project.projectName, // 
      generationType: generationType || "Full Blueprint",
      prompt,
      tokensUsed,
      generatedOutput,
      status: "Completed",
      user: user?.name,
      userId: user?.id || null, 
      createdAt: new Date(),
      updatedAt: new Date(),
      createdAt: new Date()
    };
    const result = await aiGenerationsCollection.insertOne(newGeneration);
     if (user?.id) { 
      const newNotification = {
        userId: user.id, 
        title: ` AI Copilot Active`,
        message: `New code/response generated for project "${project.projectName}".`,
        isRead: false,
        createdAt: new Date()
      };
      await db.collection("notifications").insertOne(newNotification);
    }
    
    res.status(201).json({
      success: true,
      message: "AI Generation completed and saved successfully",
      generation: {
        _id: result.insertedId,
        ...newGeneration
      }
    });

  } catch (error) {
    console.error("Error in POST /api/projects/:id/generations:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 
app.get('/api/projects/:id/generations', async (req, res) => {
  try {
    const projectId = req.params.id;
    const generations = await aiGenerationsCollection
      .find({ projectId: new ObjectId(projectId) })
      .sort({ createdAt: 1 }) 
      .toArray();

    res.json({
      success: true,
      generations
    });

  } catch (error) {
    console.error("Error in GET /api/projects/:id/generations:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 
app.get('/api/generations', async (req, res) => {
  try {

    const generations = await aiGenerationsCollection.find({}).sort({ createdAt: -1 }).toArray();
    
    res.status(200).json({
      success: true,
      count: generations.length,
      generations
    });
  } catch (error) {
    console.error("Error in GET /api/generations:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/generations/:id', async (req, res) => {
  try {
    const generationId = req.params.id;
    const { generatedOutput, prompt, generationType } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    if (generatedOutput !== undefined) updateData.generatedOutput = generatedOutput;
    if (prompt !== undefined) updateData.prompt = prompt;
    if (generationType !== undefined) updateData.generationType = generationType;

    const result = await aiGenerationsCollection.updateOne(
      { _id: new ObjectId(generationId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: "Generation log not found" });
    }

    res.status(200).json({
      success: true,
      message: "Generation history log updated successfully"
    });
  } catch (error) {
    console.error("Error in PATCH /api/generations/:id:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ৪. POST /api/generations/:id/regenerate 
app.post('/api/generations/:id/regenerate', async (req, res) => {
  try {
    const generationId = req.params.id;

    const oldGen = await aiGenerationsCollection.findOne({ _id: new ObjectId(generationId) });
    if (!oldGen) {
      return res.status(404).json({ success: false, error: "Original generation log not found" });
    }
    const project = await projectsCollection.findOne({ _id: oldGen.projectId });
    if (!project) {
      return res.status(404).json({ success: false, error: "Associated project context lost" });
    }

    const geminiPrompt = `
      You are DevPilot Copilot, an expert AI software engineer. 
      You are helping the user rebuild/regenerate a solution.
      
      [PROJECT CONTEXT]
      Project Name: ${project.projectName}
      Category: ${project.category}
      Target Users/Scale: ${project.targetUsers}
      Tech Stack: ${project.selectedTech ? project.selectedTech.join(", ") : "Not specified"}
      
      [USER'S ORIGINAL REQUEST]
      "${oldGen.prompt}"
      
      Instructions: Regenerate the solution. Provide improved, clean, and optimized code or response that fits perfectly.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: geminiPrompt
    });

    const newOutput = response.text;

    await aiGenerationsCollection.updateOne(
      { _id: new ObjectId(generationId) },
      { 
        $set: { 
          generatedOutput: newOutput,
          status: "Completed",
          updatedAt: new Date()
        } 

      }
    );

    res.status(200).json({
      success: true,
      message: "Regenerated successfully",
      generatedOutput: newOutput
    });

  } catch (error) {
    console.error("Error in REGENERATE route:", error);
    await aiGenerationsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: "Failed", updatedAt: new Date() } }
    ).catch(() => {});
    
    res.status(500).json({ success: false, error: error.message });
  }
});


// ৫. DELETE /api/generations/:id
app.delete('/api/generations/:id', async (req, res) => {
  try {
    const generationId = req.params.id;

    const result = await aiGenerationsCollection.deleteOne({ _id: new ObjectId(generationId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: "Generation log not found or already deleted" });
    }

    res.status(200).json({
      success: true,
      message: "AI Generation log deleted successfully from history"
    });
  } catch (error) {
    console.error("Error in DELETE /api/generations/:id:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.get('/api/profile/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }
    
    const userBase = await db.collection("user").findOne({ _id: new ObjectId(userId) });

    if (!userBase) {
      return res.status(404).json({ success: false, error: "User account node not found" });
    }
    
    const profileExtra = await db.collection("profiles").findOne({ userId: userId });
  
    const completeProfile = {
      name: userBase.name || "",
      email: userBase.email || "",
      image: userBase.image || "",
      memberSince: userBase.createdAt, 
      bio: profileExtra?.bio || "",
      country: profileExtra?.country || "",
      jobTitle: profileExtra?.jobTitle || "",
      skills: profileExtra?.skills || [],
      experience: profileExtra?.experience || 0,
      preferredTechStack: profileExtra?.preferredTechStack || [],
      currentRole: profileExtra?.currentRole || "",
      github: profileExtra?.github || "",
      linkedin: profileExtra?.linkedin || "",
      portfolio: profileExtra?.portfolio || "",
      twitter: profileExtra?.twitter || ""
    };

    const projectsCount = await db.collection("projects").countDocuments({ userId: userId });
    const aiGenerationsCount = await db.collection("ai_generations").countDocuments({ userId: userId }); 
    const readmeExportsCount = await db.collection("exports").countDocuments({ userId: userId }); 
    const recentProjects = await db.collection("projects")
      .find({ userId: userId })
      .sort({ createdAt: -1 }) 
      .limit(3)
      .toArray();
    const achievements = [];
    if (projectsCount > 0) {
      achievements.push({ 
        title: "First Blueprint Created", 
        badge: "", 
        desc: "Successfully deployed your first project blueprint." 
      });
    }
    if (aiGenerationsCount >= 50) {
      achievements.push({ 
        title: "Power Generator", 
        badge: "", 
        desc: "Completed over 50 deep AI generation tokens." 
      });
    } else {
      achievements.push({ 
        title: "Initiated Core Engine", 
        badge: "", 
        desc: "Started using AI generation pipelines." 
      });
    }
    res.status(200).json({ 
      success: true, 
      profile: completeProfile,
      stats: {
        projectsCount,
        aiGenerationsCount,
        readmeExportsCount,
        achievementsCount: achievements.length
      },
      recentProjects,
      achievements
    });

  } catch (error) {
    console.error("Error in GET /api/profile:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profile/update', async (req, res) => {
  try {
    const { 
      userId, bio, country, jobTitle, skills, 
      experience, preferredTechStack, currentRole, 
      github, linkedin, portfolio, twitter 
    } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }
    const updatedProfile = {
      userId,
      bio: bio || "",
      country: country || "",
      jobTitle: jobTitle || "",
      skills: Array.isArray(skills) ? skills : [],
      experience: Number(experience) || 0,
      preferredTechStack: Array.isArray(preferredTechStack) ? preferredTechStack : [],
      currentRole: currentRole || "",
      github: github || "",
      linkedin: linkedin || "",
      portfolio: portfolio || "",
      twitter: twitter || "",
      updatedAt: new Date()
    };

    const result = await db.collection("profiles").updateOne(
      { userId: userId },
      { 
        $set: updatedProfile,
        $setOnInsert: { createdAt: new Date() } 
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: "Profile dimensions synchronized successfully!",
      data: result
    });

  } catch (error) {
    console.error("Error in POST /api/profile/update:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});
 

// ১. PREFERENCES UPDATE (PATCH) 
app.patch('/api/user/preferences', async (req, res) => {
  try {
    const { userId, aiPreferences, notifications, appearance, defaultExportFormat } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }

    const isRequestingProModel = aiPreferences?.defaultModel === "gemini-2.5-pro";
    const isRequestingProExport = defaultExportFormat === "PDF" || defaultExportFormat === "DOCX";

    if (isRequestingProModel || isRequestingProExport) {
      const subscription = await db.collection("user_subscriptions").findOne({ 
        userId: userId, 
        status: "active" 
      });

      if (!subscription || subscription.plan !== "Pro") {
        const errorMsg = isRequestingProModel 
          ? "Access Denied: Gemini 2.5 Pro requires an active Architect Pro subscription."
          : "Access Denied: PDF and DOCX document compiling requires Architect Pro.";
          
        return res.status(403).json({ success: false, error: errorMsg });
      }
    }
    const result = await db.collection("user_preferences").updateOne(
      { userId: userId },
      {
        $set: {
          aiPreferences: aiPreferences || {},
          notifications: notifications || {},
          appearance: appearance || "system",
          defaultExportFormat: defaultExportFormat || "Markdown",
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      message: "Preferences synchronized successfully",
      data: result
    });

  } catch (error) {
    console.error("Error in PATCH /api/user/preferences:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// ২. PREFERENCES GET ROUTE
app.get('/api/user/preferences/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }

    const prefs = await db.collection("user_preferences").findOne({ userId: userId });
    
    res.status(200).json({
      success: true,
      data: prefs || null 
    });

  } catch (error) {
    console.error("Error in GET /api/user/preferences:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 
 app.get("/api/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }

    const notifications = await db.collection("notifications")
      .find({ userId: userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});   

  app.patch("/api/notifications/read/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, error: "Notification ID is required" });
    }
    const result = await db.collection("notifications").updateOne(
      { _id: new ObjectId(id) },
      { $set: { isRead: true } }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ success: false, error: "Notification not found or already read" });
    }

    res.json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error("Error updating notification status:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/user/delete-account/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, error: "User ID is required" });
    }
    await projectsCollection.deleteMany({ userId: userId });

    let userQuery = { _id: userId }; 
    if (ObjectId.isValid(userId)) {
      userQuery = { _id: new ObjectId(userId) };
    }

    const deleteUser = await db.collection('user').deleteOne(userQuery); 

    if (deleteUser.deletedCount === 0) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, message: "Account and all associated data deleted permanently." });

  } catch (error) {
    console.error("Error deleting account:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

    // text upore

  } catch (err) {
    console.error("MongoDB Initialization Error:", err);
  }

}



run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('DevPilot AI Server is Running...');
});


app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});