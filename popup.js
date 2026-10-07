document.getElementById('scanBtn').addEventListener('click', async () => {
    const token = document.getElementById('tokenInput').value.trim();
    const idString = document.getElementById('idInput').value.trim();
    const tableBody = document.getElementById('resultTableBody');
    const loading = document.getElementById('loading');

    if (!token || !idString) {
        alert("Pro điền thiếu Token hoặc ID kìa!");
        return;
    }

    tableBody.innerHTML = '';
    loading.style.display = 'block';

    const accountIds = idString.split(',').map(id => id.trim()).filter(id => id);

    for (const accountId of accountIds) {
        try {
            // Đã lược bỏ chữ spend để tránh lỗi Invalid Request lúc nãy
            const url = `https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=name,effective_status,daily_budget&access_token=${token}`;

            const response = await fetch(url);
            const data = await response.json();

            if (data.error) {
                tableBody.innerHTML += `<tr><td class="text-red font-bold">${accountId}</td><td colspan="3" class="text-red">Lỗi: ${data.error.message}</td></tr>`;
                continue;
            }

            const allCampaigns = data.data || [];
            const activeCampaigns = allCampaigns.filter(camp => camp.effective_status === 'ACTIVE');

            if (activeCampaigns.length === 0) {
                tableBody.innerHTML += `<tr><td style="color:#a0aec0">${accountId}</td><td colspan="3" style="color:#a0aec0">Tài khoản ngủ đông (Không có camp ACTIVE)</td></tr>`;
            } else {
                activeCampaigns.forEach(camp => {
                    const budget = camp.daily_budget ? (camp.daily_budget / 100).toLocaleString('vi-VN') + ' đ' : 'Trọn đời';
                    tableBody.innerHTML += `
                        <tr>
                            <td style="color:#90cdf4; font-weight:bold;">${accountId}</td>
                            <td>${camp.name}</td>
                            <td><span class="text-green">ACTIVE</span></td>
                            <td class="text-yellow">${budget}</td>
                        </tr>
                    `;
                });
            }
        } catch (error) {
            tableBody.innerHTML += `<tr><td class="text-red font-bold">${accountId}</td><td colspan="3" class="text-red">Lỗi mạng! Không gọi được API.</td></tr>`;
        }
    }
    loading.style.display = 'none';
});